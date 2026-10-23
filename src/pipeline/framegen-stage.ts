/**
 * One DLSS Frame Generation stage: a DLSS-G host process (dlssg-host-launch.ts)
 * that synthesises frames, a guide thread that computes the motion and
 * scene-cut hints it needs,
 * and — for the stage doing the most evaluations — a packer thread so that
 * upsampling does not sit on the guide's critical path.
 *
 * A cascade chains several of these in memory; a native run uses one.
 */
import { DlssgSession } from "./dlssg.ts";
import type { TimedFrame } from "./nearest-timestamp-writer.ts";
import { type Rational, ratAdd, ratMul, ratSub, rational } from "./rational.ts";
import { ABORT_TIMEOUT_MS } from "./worker-abort.ts";
import type { GuideFlow, GuideOpen, GuideOut, GuidePack, GuidePrepare, PackerOpen } from "./workers/framegen-guide-worker.ts";

/** A frame after its stage's guide worker ran: what the native evaluation needs. */
export interface PreparedFrame {
  frame: TimedFrame;
  previousTimestamp: Rational | null;
  /** Packed R16G16_FLOAT motion, or null for zero motion (reset / duplicate). */
  half: Uint16Array | null;
  reset: boolean;
}

/** A frame the guide thread has analysed; its grid flow still needs packing unless the guide packed inline. */
export interface AnalyzedFrame {
  frame: TimedFrame;
  previousTimestamp: Rational | null;
  reset: boolean;
  small: Float32Array | null;
  half: Uint16Array | null;
}

/** What a stage is built from once its parts have opened (openStages in framegen.ts). */
export interface StageParts {
  session: DlssgSession;
  guide: Worker;
  packer: Worker | null;
  generatedCount: number;
  /** Zero motion, sent for a reset or a duplicate frame. */
  zeros: Uint16Array;
  /** How the guide reported it estimates flow when it opened. */
  guideFlow: GuideFlow;
}

/** One DLSSG stage: a host-process session driven from the main thread, a guide thread, and (for the bottleneck stage) a packer thread. */
export class Stage {
  sceneCuts = 0;
  /** Real intervals (no reset) this stage has evaluated. */
  intervals = 0;
  generatedTotal = 0;
  readonly session: DlssgSession;
  readonly guide: Worker;
  readonly packer: Worker | null;
  readonly generatedCount: number;
  readonly flow: GuideFlow["flow"];
  /** Why this stage fell back to the CPU matcher, when it did. */
  readonly flowReason: string | null;
  private readonly zeros: Uint16Array;
  private nextIndex = 0;
  private waiter: { id: number; frame: TimedFrame; resolve: (a: AnalyzedFrame) => void; reject: (e: Error) => void } | null = null;
  private packWaiter: { id: number; analyzed: AnalyzedFrame; resolve: (p: PreparedFrame) => void; reject: (e: Error) => void } | null = null;
  private failed: Error | null = null;

  constructor({ session, guide, packer, generatedCount, zeros, guideFlow }: StageParts) {
    this.session = session;
    this.guide = guide;
    this.packer = packer;
    this.generatedCount = generatedCount;
    this.zeros = zeros;
    this.flow = guideFlow.flow;
    this.flowReason = guideFlow.flowReason;
    guide.onmessage = (event: MessageEvent) => {
      const m = event.data as GuideOut;
      if (m.type === "prepared") {
        const pendingGuide = this.waiter;
        if (!pendingGuide) return;
        if (m.id !== pendingGuide.id) {
          this.fail(new Error(`frame-generation guide worker answered request ${m.id} while ${pendingGuide.id} was pending`));
          return;
        }
        this.waiter = null;
        this.sceneCuts = m.sceneCuts;
        pendingGuide.resolve({
          frame: m.segment === pendingGuide.frame.segment ? pendingGuide.frame : { ...pendingGuide.frame, segment: m.segment },
          previousTimestamp: m.previousTsNum !== null && m.previousTsDen !== null ? { num: m.previousTsNum, den: m.previousTsDen } : null,
          reset: m.reset,
          small: m.small ? new Float32Array(m.small) : null,
          half: m.half ? new Uint16Array(m.half) : null,
        });
      } else if (m.type === "error") {
        this.fail(new Error(`frame-generation guide worker: ${m.message}`));
      }
    };
    guide.addEventListener("error", (e) => this.fail(new Error(`frame-generation guide worker crashed: ${(e as ErrorEvent).message}`)));
    if (packer) {
      packer.onmessage = (event: MessageEvent) => {
        const m = event.data as GuideOut;
        if (m.type === "packed") {
          const pendingPack = this.packWaiter;
          if (!pendingPack) return;
          if (m.id !== pendingPack.id) {
            this.fail(new Error(`frame-generation packer worker answered request ${m.id} while ${pendingPack.id} was pending`));
            return;
          }
          this.packWaiter = null;
          pendingPack.resolve({ frame: pendingPack.analyzed.frame, previousTimestamp: pendingPack.analyzed.previousTimestamp, half: new Uint16Array(m.half), reset: pendingPack.analyzed.reset });
        } else if (m.type === "error") {
          this.fail(new Error(`frame-generation packer worker: ${m.message}`));
        }
      };
      packer.addEventListener("error", (e) => this.fail(new Error(`frame-generation packer worker crashed: ${(e as ErrorEvent).message}`)));
    }
  }

  private fail(error: Error): void {
    this.failed ??= error;
    const pendingGuide = this.waiter;
    this.waiter = null;
    pendingGuide?.reject(error);
    const pendingPack = this.packWaiter;
    this.packWaiter = null;
    pendingPack?.reject(error);
  }

  /** Run the guide analysis for one frame on this stage's thread (one at a time, in stream order). */
  prepare(frame: TimedFrame, id: number): Promise<AnalyzedFrame> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<AnalyzedFrame>((resolve, reject) => {
      this.waiter = { id, frame, resolve, reject };
      this.guide.postMessage({ type: "prepare", id, rgba: frame.rgba, segment: frame.segment, tsNum: frame.timestamp.num, tsDen: frame.timestamp.den } satisfies GuidePrepare);
    });
  }

  /** Upsample + pack the grid flow on this stage's packer thread; immediate when the guide already packed it. */
  pack(analyzed: AnalyzedFrame, id: number): Promise<PreparedFrame> {
    if (this.failed) return Promise.reject(this.failed);
    if (analyzed.small === null) return Promise.resolve({ frame: analyzed.frame, previousTimestamp: analyzed.previousTimestamp, half: analyzed.half, reset: analyzed.reset });
    const packer = this.packer;
    if (!packer) return Promise.reject(new Error("frame-generation stage got unpacked flow but has no packer thread"));
    return new Promise<PreparedFrame>((resolve, reject) => {
      this.packWaiter = { id, analyzed, resolve, reject };
      const buffer = analyzed.small!.buffer as ArrayBuffer;
      packer.postMessage({ type: "pack", id, small: buffer } satisfies GuidePack, [buffer]);
    });
  }

  /** Synthesised frames that precede the real frame, then the real frame itself. */
  async evaluate(prepared: PreparedFrame): Promise<TimedFrame[]> {
    const { frame } = prepared;
    if (!prepared.reset) this.intervals++;
    const generated = await this.session.processFrame({ rgba: frame.rgba, motion: prepared.half ?? this.zeros, index: this.nextIndex++, reset: prepared.reset });
    this.generatedTotal += generated.length;
    const output: TimedFrame[] = [];
    if (!prepared.reset && prepared.previousTimestamp !== null) {
      const interval = ratSub(frame.timestamp, prepared.previousTimestamp);
      generated.forEach((rgba, index) => {
        output.push({
          rgba,
          timestamp: ratAdd(prepared.previousTimestamp!, ratMul(interval, rational(index + 1, this.generatedCount + 1))),
          segment: frame.segment,
          provenance: "DLSSG",
          sourceIndex: null,
        });
      });
    }
    output.push(frame);
    return output;
  }

  /** Bounded by ABORT_TIMEOUT_MS as a whole, the budget every pipeline's teardown fits (worker-abort.ts). */
  async close(): Promise<void> {
    await releaseStageParts({ session: this.session, guide: this.guide, packer: this.packer });
  }
}

/**
 * Releases what a stage holds, or what came up of one whose open failed partway, within ABORT_TIMEOUT_MS as a whole.
 * The guide thread owns an NVOFA session on the process-wide CUDA primary context, so terminating the thread does not
 * release it: the thread is asked to close first. The packer thread holds no such session.
 */
export async function releaseStageParts({ session, guide, packer }: { session: DlssgSession | null; guide: Worker | null; packer: Worker | null }): Promise<void> {
  if (guide) await releaseGuideThread(guide);
  if (packer) try { packer.terminate(); } catch {}
  if (session) await session.close(ABORT_TIMEOUT_MS - GUIDE_CLOSE_TIMEOUT_MS);
}

/**
 * How long to wait for a guide thread to report its NVOFA session released
 * before terminating it anyway. A thread wedged inside a driver call must not
 * hold up the rest of the teardown, which close() fits inside ABORT_TIMEOUT_MS.
 * Terminating it leaves its session allocated on the CUDA primary context until
 * the process exits: in the server, until it is restarted.
 */
const GUIDE_CLOSE_TIMEOUT_MS = 2000;

/** Ask a guide thread to release its NVOFA session, then terminate it either way. */
async function releaseGuideThread(guide: Worker): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      guide.onmessage = null;
      resolve();
    };
    const timer = setTimeout(done, GUIDE_CLOSE_TIMEOUT_MS);
    guide.onmessage = (event: MessageEvent) => {
      if ((event.data as GuideOut).type === "closed") done();
    };
    try {
      guide.postMessage({ type: "close" });
    } catch {
      done(); // already gone
    }
  });
  try {
    guide.terminate();
  } catch {
    /* already gone */
  }
}

/**
 * Start a guide-side worker in either role and wait until it is ready (a guide's NVOFA session included); a guide
 * also hands back how it estimates flow. `createWorker` starts the thread; tests hand in a stand-in.
 */
export function openGuideWorker(open: GuideOpen, createWorker?: (script: URL) => Worker): Promise<{ worker: Worker } & GuideFlow>;
export function openGuideWorker(open: PackerOpen, createWorker?: (script: URL) => Worker): Promise<{ worker: Worker }>;
export async function openGuideWorker(
  open: GuideOpen | PackerOpen,
  createWorker: (script: URL) => Worker = (script) => new Worker(script.href),
): Promise<{ worker: Worker } | ({ worker: Worker } & GuideFlow)> {
  const role = open.type === "open" ? "guide" : "packer";
  const worker = createWorker(new URL("./workers/framegen-guide-worker.ts", import.meta.url));
  try {
    return await new Promise((resolve, reject) => {
      const onError = (e: Event) => { reject(new Error(`frame-generation ${role} worker failed to start: ${(e as ErrorEvent).message}`)); };
      worker.addEventListener("error", onError, { once: true });
      worker.onmessage = (event: MessageEvent) => {
        const m = event.data as GuideOut;
        if (m.type === "opened") { worker.removeEventListener("error", onError); worker.onmessage = null; resolve("flow" in m ? { worker, flow: m.flow, flowReason: m.flowReason } : { worker }); }
        else if (m.type === "error") { reject(new Error(`frame-generation ${role} worker: ${m.message}`)); }
      };
      worker.postMessage(open);
    });
  } catch (error) {
    // The caller gets no worker handle from a failed open, so nobody else can end this thread.
    try { worker.terminate(); } catch { /* already gone */ }
    throw error;
  }
}
