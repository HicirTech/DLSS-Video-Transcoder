/**
 * One DLSS Frame Generation stage: a dlssg-worker process that synthesises
 * frames, a guide thread that computes the motion and scene-cut hints it needs,
 * and — for the stage doing the most evaluations — a packer thread so that
 * upsampling does not sit on the guide's critical path.
 *
 * A cascade chains several of these in memory; a native run uses one.
 */
import { DlssgSession } from "./dlssg.ts";
import type { TimedFrame } from "./framegen-plan.ts";
import { type Rational, ratAdd, ratMul, ratSub, rational } from "./rational.ts";
export interface PreparedFrame {
  frame: TimedFrame;
  previousTimestamp: Rational | null;
  /** Packed R16G16_FLOAT motion, or null for zero motion (reset / duplicate). */
  half: Uint16Array | null;
  reset: boolean;
}

interface GuideReply {
  type: "prepared";
  id: number;
  reset: boolean;
  segment: number;
  previousTsNum: bigint | null;
  previousTsDen: bigint | null;
  small: ArrayBuffer | null;
  half: ArrayBuffer | null;
  sceneCuts: number;
}

interface PackReply {
  type: "packed";
  id: number;
  half: ArrayBuffer;
}

/** A frame the guide thread has analysed; its grid flow still needs packing unless the guide packed inline. */
export interface AnalyzedFrame {
  frame: TimedFrame;
  previousTimestamp: Rational | null;
  reset: boolean;
  small: Float32Array | null;
  half: Uint16Array | null;
}

/** One DLSSG stage: a worker-process session driven from the main thread, a guide thread, and (for the bottleneck stage) a packer thread. */
export class Stage {
  sceneCuts = 0;
  /** Real intervals (no reset) this stage has evaluated. */
  intervals = 0;
  generatedTotal = 0;
  flow: "nvof" | "cpu" | "?" = "?";
  /** Why this stage fell back to the CPU matcher, when it did. */
  flowReason: string | null = null;
  private nextIndex = 0;
  private waiter: { frame: TimedFrame; resolve: (a: AnalyzedFrame) => void; reject: (e: Error) => void } | null = null;
  private packWaiter: { analyzed: AnalyzedFrame; resolve: (p: PreparedFrame) => void; reject: (e: Error) => void } | null = null;
  private failed: Error | null = null;

  constructor(
    readonly session: DlssgSession,
    readonly guide: Worker,
    readonly packer: Worker | null,
    readonly generatedCount: number,
    private readonly zeros: Uint16Array,
  ) {
    guide.onmessage = (event: MessageEvent) => {
      const m = event.data as GuideReply | { type: "error"; message: string } | { type: "opened" | "closed" };
      if (m.type === "prepared") {
        const w = this.waiter;
        this.waiter = null;
        if (!w) return;
        this.sceneCuts = m.sceneCuts;
        w.resolve({
          frame: m.segment === w.frame.segment ? w.frame : { ...w.frame, segment: m.segment },
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
        const m = event.data as PackReply | { type: "error"; message: string } | { type: "opened" | "closed" };
        if (m.type === "packed") {
          const w = this.packWaiter;
          this.packWaiter = null;
          if (!w) return;
          w.resolve({ frame: w.analyzed.frame, previousTimestamp: w.analyzed.previousTimestamp, half: new Uint16Array(m.half), reset: w.analyzed.reset });
        } else if (m.type === "error") {
          this.fail(new Error(`frame-generation packer worker: ${m.message}`));
        }
      };
      packer.addEventListener("error", (e) => this.fail(new Error(`frame-generation packer worker crashed: ${(e as ErrorEvent).message}`)));
    }
  }

  private fail(error: Error): void {
    this.failed ??= error;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(error);
    const p = this.packWaiter;
    this.packWaiter = null;
    p?.reject(error);
  }

  /** Run the guide analysis for one frame on this stage's thread (one at a time, in stream order). */
  prepare(frame: TimedFrame, id: number): Promise<AnalyzedFrame> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<AnalyzedFrame>((resolve, reject) => {
      this.waiter = { frame, resolve, reject };
      this.guide.postMessage({ type: "prepare", id, rgba: frame.rgba, segment: frame.segment, tsNum: frame.timestamp.num, tsDen: frame.timestamp.den });
    });
  }

  /** Upsample + pack the grid flow on this stage's packer thread; immediate when the guide already packed it. */
  pack(analyzed: AnalyzedFrame, id: number): Promise<PreparedFrame> {
    if (this.failed) return Promise.reject(this.failed);
    if (analyzed.small === null) return Promise.resolve({ frame: analyzed.frame, previousTimestamp: analyzed.previousTimestamp, half: analyzed.half, reset: analyzed.reset });
    const packer = this.packer;
    if (!packer) return Promise.reject(new Error("frame-generation stage got unpacked flow but has no packer thread"));
    return new Promise<PreparedFrame>((resolve, reject) => {
      this.packWaiter = { analyzed, resolve, reject };
      const buffer = analyzed.small!.buffer as ArrayBuffer;
      packer.postMessage({ type: "pack", id, small: buffer }, [buffer]);
    });
  }

  /** Synthesised frames that precede the real frame, then the real frame itself. */
  async evaluate(prepared: PreparedFrame): Promise<TimedFrame[]> {
    const { frame } = prepared;
    if (!prepared.reset) this.intervals++;
    const generated = await this.session.processFrame(frame.rgba, prepared.half ?? this.zeros, this.nextIndex++, prepared.reset, frame.timestamp.num, frame.timestamp.den);
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

  async close(): Promise<void> {
    try { this.guide.terminate(); } catch {}
    if (this.packer) try { this.packer.terminate(); } catch {}
    await this.session.close();
  }
}

type OpenGuide = { type: "open"; width: number; height: number; detectSourceCuts: boolean; packInline: boolean } | { type: "open-packer"; width: number; height: number };

/** Start a guide-side worker in either role and wait until it is ready (its NVOFA session included). */
export function openGuideWorker(open: OpenGuide): Promise<{ worker: Worker; flow: "nvof" | "cpu" | "pack"; flowReason: string | null }> {
  return new Promise((resolve, reject) => {
    const role = open.type === "open" ? "guide" : "packer";
    const worker = new Worker(new URL("./workers/framegen-guide-worker.ts", import.meta.url).href);
    const onError = (e: Event) => { reject(new Error(`frame-generation ${role} worker failed to start: ${(e as ErrorEvent).message}`)); };
    worker.addEventListener("error", onError, { once: true });
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as { type: string; flow?: "nvof" | "cpu" | "pack"; flowReason?: string | null; message?: string };
      if (m.type === "opened") { worker.removeEventListener("error", onError); worker.onmessage = null; resolve({ worker, flow: m.flow ?? "cpu", flowReason: m.flowReason ?? null }); }
      else if (m.type === "error") { reject(new Error(`frame-generation ${role} worker: ${m.message}`)); }
    };
    worker.postMessage(open);
  });
}
