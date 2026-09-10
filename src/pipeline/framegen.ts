/**
 * Video frame generation to an exact target frame rate: ffmpeg decode -> one or
 * more DLSSG stages -> a nearest-timestamp writer -> encode, coordinated here.
 *
 * Two paths (chosen in framegen-plan.ts):
 *
 *   - Native DLSSG: one session generating m-1 frames per interval, m = target
 *     / source an exact integer the runtime supports. m >= 3 needs HAGS.
 *   - Cascade: 2x stages chained IN MEMORY — stage k interpolates between the
 *     frames stage k-1 produced, so no intermediate encode — reaching a
 *     2^stages grid. This is what reaches 4x/8x on runtimes that only do 2x,
 *     and any non-integer ratio (30 -> 144).
 *
 * The output frame count comes from the source DURATION, never from how many
 * frames the worker returned, so the result matches the source length whatever
 * was synthesised. The muxed file is verified (frame count + rate) before the
 * job reports success.
 *
 * Ported from the reference project's frame_interpolation package.
 */
import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { EncodeSettings } from "../server/api-types.ts";
import { DlssgSession, probeDlssgCached } from "./dlssg.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { FrameReader } from "./frame-reader.ts";
import {
  type FrameGenEngine,
  type InterpolationPlan,
  NearestTimestampWriter,
  type TimedFrame,
  chooseInterpolationPlan,
  formatRate,
  outputFrameCount,
  resolveTargetRate,
} from "./framegen-plan.ts";
import type { NvencCodec } from "./nvenc.ts";
import { type Rational, formatRational, parseRational, ratAdd, ratCmp, ratDiv, ratMul, ratSub, ratToNumber, rational } from "./nut.ts";
import { evenSize } from "./resize.ts";
import { findTool } from "./tools.ts";
import { encoderArgs, nvencNativeTarget, probeVideo } from "./video.ts";

export interface FrameGenOptions {
  input: string;
  output?: string;
  /**
   * Output frame rate: a named rate ("60", "59.94", "120", "144", ... see
   * FPS_CHOICES), an exact "num/den", or a decimal. Takes precedence over
   * `multiplier` when both are given.
   */
  targetFps?: string;
  /** Convenience when `targetFps` is absent: output = source rate x multiplier (2 = double the fps). Default 2. */
  multiplier?: number;
  /**
   * auto: native multi-frame when the ratio is an exact integer the runtime
   * supports AND HAGS is on, otherwise a cascade of 2x stages. native / cascade
   * force that path. Default auto.
   */
  engine?: FrameGenEngine;
  runtimeDir: string;
  quality?: number;
  /** Output codec; defaults to NVENC H.264 when available, else CPU libx264. */
  codec?: EncodeSettings["codec"];
  /** Frames in flight across the whole pipeline, in bytes (default 1 GiB). */
  bufferLimitBytes?: number;
  onProgress?: (fraction: number, message: string, frames?: number) => void;
}

export interface FrameGenResult {
  output: string;
  width: number;
  height: number;
  sourceFps: number;
  outputFps: number;
  /** Display form of the target rate, e.g. "59.94" or "120". */
  targetFps: string;
  /** Which path produced the frames. */
  path: InterpolationPlan["path"];
  nativeMultiplier: number;
  cascadeStages: number;
  /** Effective output/input rate ratio. */
  multiplier: number;
  inputFrames: number;
  outputFrames: number;
  copiedFrames: number;
  generatedFrames: number;
  /** Source frames that no output instant selected (target below source, or heavy resampling). */
  droppedFrames: number;
  sceneCuts: number;
  /** Largest distance between an output instant and the frame chosen for it. */
  maximumTemporalErrorSeconds: number;
  hagsEnabled: boolean;
  /** "overlapped" (threads + concurrent stages) or "sequential" (fallback for frames too large for the buffer limit). */
  mode: "overlapped" | "sequential";
  /** Peak bytes of frames in flight. */
  peakBufferBytes: number;
  ms: number;
}

export function defaultFrameGenOutput(input: string): string {
  const ext = extname(input);
  return join(dirname(input), `${basename(input, ext)}.dlssg.mp4`);
}

/** Real inter-frame intervals to tolerate with zero synthesised frames before concluding generation is disabled. */
const FG_PROBE_INTERVALS = 8;
const DEFAULT_BUFFER_LIMIT = 1 << 30;

/** Raised when the worker synthesised nothing; carries the plan so "auto" can retry with a cascade. */
export class FrameGenDisabledError extends Error {
  constructor(message: string, readonly plan: InterpolationPlan) {
    super(message);
    this.name = "FrameGenDisabledError";
  }
}

/**
 * The writer would still emit a correctly timed file with nothing synthesised,
 * but it would be a duplicate-frame resample sold as frame generation, so the
 * job fails with the actual cause instead.
 */
function frameGenDisabledError(plan: InterpolationPlan, disabledFrames: number, hagsEnabled: boolean): FrameGenDisabledError {
  const wanted = `${formatRate(plan.sourceRate)} -> ${formatRate(plan.targetRate)} fps via ${plan.path}`;
  const reported = disabledFrames ? `; the worker reported generation disabled for ${disabledFrames} frame(s)` : "";
  const multiFrame = plan.path === "Native DLSSG" && plan.generatedPerInterval >= 2;
  const hint = multiFrame
    ? hagsEnabled
      ? " This dlssg-worker build synthesises only one frame per interval (2x) even with HAGS on; the cascade engine reaches higher rates from 2x stages, and auto falls back to it automatically."
      : " Multi-frame (3x and above) DLSS Frame Generation requires Windows hardware-accelerated GPU scheduling (HAGS), which is off on this machine: enable it under Settings > System > Display > Graphics > Default graphics settings and reboot, or use the cascade engine (auto falls back to it automatically)."
    : " Check that the GPU driver is current and the dlssg runtime folder is complete; the cascade engine only needs 2x generation.";
  return new FrameGenDisabledError(`DLSS Frame Generation produced no interpolated frames (${wanted})${reported}.${hint} No output was written.`, plan);
}

/** Once the runtime has refused a native multi-frame session in this process, "auto" skips the fail-fast probe for later jobs. */
let nativeMultiFrameRefused = false;

/**
 * An "auto" plan that chose native multi-frame and got nothing back is re-run
 * as a cascade of 2x stages, which only needs the 2x generation that always
 * works. This dlssg-worker build reports generation disabled for 3x and above
 * even with HAGS on, so the retry is the normal path, not an edge case.
 */
export async function processFrameGen(options: FrameGenOptions): Promise<FrameGenResult> {
  const engine = options.engine ?? "auto";
  if (engine === "auto" && nativeMultiFrameRefused) return processFrameGenOnce({ ...options, engine: "cascade" });
  try {
    return await processFrameGenOnce(options);
  } catch (error) {
    if (engine === "auto" && error instanceof FrameGenDisabledError && error.plan.path === "Native DLSSG" && error.plan.generatedPerInterval >= 2) {
      nativeMultiFrameRefused = true;
      options.onProgress?.(0, `native ${error.plan.nativeMultiplier}x refused by the runtime (no frames synthesised); falling back to a cascade of 2x stages`);
      return processFrameGenOnce({ ...options, engine: "cascade" });
    }
    throw error;
  }
}

/** A frame after its stage's guide worker ran: what the native evaluation needs. */
interface PreparedFrame {
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
  duplicates: number;
}

interface PackReply {
  type: "packed";
  id: number;
  half: ArrayBuffer;
}

/** A frame the guide thread has analysed; its grid flow still needs packing unless the guide packed inline. */
interface AnalyzedFrame {
  frame: TimedFrame;
  previousTimestamp: Rational | null;
  reset: boolean;
  small: Float32Array | null;
  half: Uint16Array | null;
}

/** One DLSSG stage: a worker-process session driven from the main thread, a guide thread, and (for the bottleneck stage) a packer thread. */
class Stage {
  sceneCuts = 0;
  duplicates = 0;
  /** Real intervals (no reset) this stage has evaluated. */
  intervals = 0;
  generatedTotal = 0;
  flow: "nvof" | "cpu" | "?" = "?";
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
        this.duplicates = m.duplicates;
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
function openGuideWorker(open: OpenGuide): Promise<{ worker: Worker; flow: "nvof" | "cpu" | "pack" }> {
  return new Promise((resolve, reject) => {
    const role = open.type === "open" ? "guide" : "packer";
    const worker = new Worker(new URL("./workers/framegen-guide-worker.ts", import.meta.url).href);
    const onError = (e: Event) => { reject(new Error(`frame-generation ${role} worker failed to start: ${(e as ErrorEvent).message}`)); };
    worker.addEventListener("error", onError, { once: true });
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as { type: string; flow?: "nvof" | "cpu" | "pack"; message?: string };
      if (m.type === "opened") { worker.removeEventListener("error", onError); worker.onmessage = null; resolve({ worker, flow: m.flow ?? "cpu" }); }
      else if (m.type === "error") { reject(new Error(`frame-generation ${role} worker: ${m.message}`)); }
    };
    worker.postMessage(open);
  });
}

interface OpenEncode {
  type: "open";
  ffmpeg: string;
  nvencArgs: string[];
  rawArgs: string[];
  nvenc: { width: number; height: number; fpsNum: number; fpsDen: number; codec: NvencCodec; cq: number } | null;
}

/**
 * Main-thread handle for the encode worker. write() resolves as soon as the
 * frame is accepted, with at most `window` frames in flight, so encoding
 * overlaps the rest of the pipeline while staying in display order (the worker
 * processes requests through one promise chain) and bounded in memory.
 */
class EncodeSink {
  usesNvenc = false;
  note = "";
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private failure: Error | null = null;
  private openSettle: { resolve: (sink: EncodeSink) => void; reject: (error: Error) => void } | null = null;
  private finishSettle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private abortSettle: (() => void) | null = null;

  private constructor(private readonly worker: Worker, private readonly window: number) {
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as { type: string; nvenc?: boolean; note?: string; message?: string };
      if (m.type === "opened") {
        this.usesNvenc = Boolean(m.nvenc);
        this.note = m.note ?? "";
        const settle = this.openSettle;
        this.openSettle = null;
        settle?.resolve(this);
      } else if (m.type === "encoded") {
        this.inFlight--;
        this.waiters.shift()?.();
      } else if (m.type === "done") {
        const settle = this.finishSettle;
        this.finishSettle = null;
        settle?.resolve();
      } else if (m.type === "aborted") {
        const settle = this.abortSettle;
        this.abortSettle = null;
        settle?.();
      } else if (m.type === "error") {
        this.fail(new Error(m.message ?? "frame-generation encode worker failed"));
      }
    };
    worker.addEventListener("error", (e) => this.fail(new Error(`frame-generation encode worker crashed: ${(e as ErrorEvent).message}`)));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const open = this.openSettle;
    this.openSettle = null;
    open?.reject(this.failure);
    const finish = this.finishSettle;
    this.finishSettle = null;
    finish?.reject(this.failure);
    const abort = this.abortSettle;
    this.abortSettle = null;
    abort?.();
    // Wake every writer so it observes the failure instead of waiting for a credit that will never come.
    for (const wake of this.waiters.splice(0)) wake();
  }

  static open(message: OpenEncode, window = 8): Promise<EncodeSink> {
    const worker = new Worker(new URL("./workers/framegen-encode-worker.ts", import.meta.url).href);
    const sink = new EncodeSink(worker, window);
    return new Promise<EncodeSink>((resolve, reject) => {
      sink.openSettle = { resolve, reject };
      worker.postMessage(message);
    });
  }

  async write(rgba: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    while (this.inFlight >= this.window) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.failure) throw this.failure;
    }
    this.inFlight++;
    this.worker.postMessage({ type: "frame", rgba });
  }

  /** Flush the encoder, close ffmpeg's stdin and wait for it to exit cleanly. */
  finish(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      this.finishSettle = { resolve, reject };
      this.worker.postMessage({ type: "finish" });
    });
  }

  /** Kill ffmpeg and wait for it to release the output file so the caller can delete it. */
  async abort(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.abortSettle = resolve;
      try {
        this.worker.postMessage({ type: "abort" });
      } catch {
        resolve();
        return;
      }
      setTimeout(resolve, 5000);
    });
    this.close();
  }

  close(): void {
    try { this.worker.terminate(); } catch {}
  }
}

interface RunParams {
  reader: FrameReader;
  frameBytes: number;
  sourceRate: Rational;
  stages: Stage[];
  writer: NearestTimestampWriter;
  capacity: number;
  /** Called with the number of source frames stage 0 has evaluated. */
  onProcessed: (count: number) => void;
  /** Throws when the run should abort (e.g. nothing generated after enough intervals). */
  check: () => void;
}

/**
 * Credit-bounded coordinator (reference pipeline.py, overlapped mode). Owners:
 * decode (this thread, async pipe), one guide Worker per stage (guide analysis
 * costs ~12 ms of CPU per frame at 720p, far too much for this thread), one
 * native evaluation per stage (its own dlssg-worker process, so stages overlap
 * on the GPU), and encode (its own Worker).
 *
 * One credit = one frame-sized buffer. Every possible native output is reserved
 * before an evaluation, and motion storage before a guide, so no owner ever
 * blocks on a queue put; the last stage is served first so the pipeline drains.
 */
async function runOverlapped(p: RunParams): Promise<{ decoded: number; peak: number; busy?: Record<string, number> }> {
  const { stages, writer, capacity } = p;
  const maxGenerated = Math.max(0, ...stages.map((s) => s.generatedCount));
  const edgeCapacity = Math.max(4, maxGenerated + 1);
  const edges: TimedFrame[][] = Array.from({ length: stages.length + 1 }, () => []);
  const analyzed: AnalyzedFrame[][] = stages.map(() => []);
  const prepared: PreparedFrame[][] = stages.map(() => []);
  const pending = new Set<string>();
  const done: Array<{ name: string; value?: unknown; error?: Error }> = [];
  let wake: (() => void) | null = null;
  let used = 0;
  let peak = 0;
  let decoded = 0;
  let decodeSeq = 0;
  let processed = 0;
  let guideSeq = 0;
  let ended = false;

  const reserve = (credits: number): void => {
    used += credits;
    if (used > capacity) throw new Error("Frame generation buffer reservation exceeded its limit.");
    if (used > peak) peak = used;
  };
  const busy: Record<string, number> = {};
  const start = (name: string, promise: Promise<unknown>): void => {
    pending.add(name);
    const t0 = performance.now();
    const settle = (): void => { busy[name] = (busy[name] ?? 0) + (performance.now() - t0); pending.delete(name); };
    promise.then(
      (value) => { settle(); done.push({ name, value }); wake?.(); },
      (error) => { settle(); done.push({ name, error: error instanceof Error ? error : new Error(String(error)) }); wake?.(); },
    );
  };
  const decodeOne = async (): Promise<TimedFrame | null> => {
    const index = decodeSeq++;
    const rgba = await p.reader.next(p.frameBytes);
    if (!rgba) return null;
    return { rgba, timestamp: ratDiv(rational(index), p.sourceRate), segment: 0, provenance: "Source", sourceIndex: index };
  };
  const consume = async (items: TimedFrame[]): Promise<number> => {
    for (const item of items) await writer.push(item);
    return items.length;
  };

  for (;;) {
    // Harvest everything that finished. Results own their buffers until consumed.
    while (done.length) {
      const d = done.shift()!;
      if (d.error) throw d.error;
      if (d.name === "decode") {
        const frame = d.value as TimedFrame | null;
        if (frame === null) { ended = true; used -= 1; }
        else { edges[0]!.push(frame); decoded++; }
      } else if (d.name.startsWith("guide:")) {
        analyzed[Number(d.name.slice(6))]!.push(d.value as AnalyzedFrame);
      } else if (d.name.startsWith("pack:")) {
        prepared[Number(d.name.slice(5))]!.push(d.value as PreparedFrame);
      } else if (d.name.startsWith("native:")) {
        const k = Number(d.name.slice(7));
        const { items, credits } = d.value as { items: TimedFrame[]; credits: number };
        if (items.length > credits + 1) throw new Error("DLSSG produced more frames than reserved.");
        edges[k + 1]!.push(...items);
        used -= 2 + credits - items.length;
        if (k === 0) { processed++; p.onProcessed(processed); p.check(); }
      } else if (d.name === "encode") {
        used -= d.value as number;
      }
    }

    const last = edges[stages.length]!;
    if (!pending.has("encode") && last.length) {
      const items = last.splice(0, Math.min(edgeCapacity, last.length));
      start("encode", consume(items));
    }
    for (let k = stages.length - 1; k >= 0; k--) {
      const stage = stages[k]!;
      const count = stage.generatedCount;
      const name = `native:${k}`;
      if (!pending.has(name) && prepared[k]!.length && used + count <= capacity && edges[k + 1]!.length + count + 1 <= edgeCapacity) {
        reserve(count);
        const item = prepared[k]!.shift()!;
        start(name, stage.evaluate(item).then((items) => ({ items, credits: count })));
      }
    }
    for (let k = stages.length - 1; k >= 0; k--) {
      const name = `pack:${k}`;
      // The analysed item already holds this frame's motion credit; packing just swaps the grid flow for the full field.
      if (!pending.has(name) && analyzed[k]!.length) {
        const item = analyzed[k]!.shift()!;
        start(name, stages[k]!.pack(item, ++guideSeq));
      }
    }
    for (let k = stages.length - 1; k >= 0; k--) {
      const name = `guide:${k}`;
      // Retain native output headroom even if the GPU is idle; let analysis run a little ahead of packing.
      if (!pending.has(name) && edges[k]!.length && analyzed[k]!.length + prepared[k]!.length < 3 && used + 1 <= capacity - maxGenerated) {
        reserve(1);
        const frame = edges[k]!.shift()!;
        start(name, stages[k]!.prepare(frame, ++guideSeq));
      }
    }
    if (!ended && !pending.has("decode") && edges[0]!.length < edgeCapacity && used + 1 <= capacity - maxGenerated - 1) {
      reserve(1);
      start("decode", decodeOne());
    }

    if (pending.size === 0) {
      if (ended && edges.every((e) => e.length === 0) && analyzed.every((q) => q.length === 0) && prepared.every((q) => q.length === 0)) break;
      throw new Error("Frame generation could not drain its bounded pipeline.");
    }
    if (done.length === 0) await new Promise<void>((resolve) => { wake = () => { wake = null; resolve(); }; });
  }
  trimToDecoded(p, decoded);
  await writer.finish();
  return { decoded, peak, busy };
}

/** The container may declare more frames than decode; end the output at the decoded duration instead of freezing on the last frame. */
function trimToDecoded(p: RunParams, decoded: number): void {
  const actual = outputFrameCount(ratDiv(rational(decoded), p.sourceRate), p.writer.targetRate);
  if (actual < p.writer.outputCount) p.writer.outputCount = Math.max(actual, p.writer.nextIndex);
}

/** Plain in-order fallback for frames too large for the credit window (still uses the guide threads, one step at a time). */
async function runSequential(p: RunParams): Promise<{ decoded: number; peak: number; busy?: Record<string, number> }> {
  let decoded = 0;
  let guideSeq = 0;
  for (;;) {
    const rgba = await p.reader.next(p.frameBytes);
    if (!rgba) break;
    let items: TimedFrame[] = [{ rgba, timestamp: ratDiv(rational(decoded), p.sourceRate), segment: 0, provenance: "Source", sourceIndex: decoded }];
    for (const stage of p.stages) {
      const next: TimedFrame[] = [];
      for (const item of items) next.push(...(await stage.evaluate(await stage.pack(await stage.prepare(item, ++guideSeq), ++guideSeq))));
      items = next;
    }
    for (const item of items) await p.writer.push(item);
    decoded++;
    p.onProcessed(decoded);
    p.check();
  }
  trimToDecoded(p, decoded);
  await p.writer.finish();
  return { decoded, peak: 0 };
}

/**
 * Exact frame count (packet counting, not container metadata) and rates of a
 * written video. `avgRate` = frames / duration is the timeline players follow;
 * `rate` is ffprobe's base-rate guess (r_frame_rate), kept for diagnostics.
 */
function probeOutputVideo(ffprobe: string, path: string): { frames: number; rate: Rational; avgRate: Rational; timeBase: string } {
  const proc = Bun.spawnSync([ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets,r_frame_rate,avg_frame_rate,time_base", "-of", "json", path], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`ffprobe could not verify the output: ${new TextDecoder().decode(proc.stderr).trim()}`);
  const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as { streams?: Array<{ nb_read_packets?: string; r_frame_rate?: string; avg_frame_rate?: string; time_base?: string }> };
  const stream = data.streams?.[0];
  if (!stream?.r_frame_rate) throw new Error("ffprobe found no video stream in the output.");
  const usable = (text?: string) => (text && text !== "0/0" ? text : undefined);
  return {
    frames: Number(stream.nb_read_packets ?? 0),
    rate: parseRational(stream.r_frame_rate),
    avgRate: parseRational(usable(stream.avg_frame_rate) ?? stream.r_frame_rate),
    timeBase: stream.time_base ?? "?",
  };
}

async function processFrameGenOnce(options: FrameGenOptions): Promise<FrameGenResult> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  if (!ffmpeg || !ffprobe)
    throw new Error("ffmpeg and ffprobe are required for frame generation (install with `winget install Gyan.FFmpeg` or set FFMPEG_PATH / FFPROBE_PATH).");

  const workerDir = join(options.runtimeDir, "dlssg");
  const caps = await probeDlssgCached(workerDir);
  if (!caps.available) throw new Error(`DLSS Frame Generation is not available: ${caps.detail}`);
  const nativeMultiplierMax = caps.multiFrameCountMax + 1;

  const info = probeVideo(ffprobe, options.input);
  // Every encoder here writes 4:2:0, which cannot represent an odd dimension,
  // so the whole chain runs at even sizes and the decoder scales to match --
  // the same rule video.ts and image.ts apply to their targets.
  const width = evenSize(info.width);
  const height = evenSize(info.height);
  const rescaled = width !== info.width || height !== info.height;
  const frameBytes = width * height * 4;
  if (info.frames === null || info.frames <= 0)
    throw new Error("Could not determine the source frame count, which fixes the output length. Re-mux the file (e.g. `ffmpeg -i in -c copy out.mp4`) so ffprobe can read it.");
  const frames = info.frames;
  // The nominal CFR clock, not the measured average: planning needs exact ratios (30 -> 60 must be 2x).
  const sourceRate = parseRational(info.nominalFpsText ?? info.fpsText);
  const multiplier = Math.max(1, Math.round(options.multiplier ?? 2));
  const targetRate = options.targetFps !== undefined ? resolveTargetRate(options.targetFps) : ratMul(sourceRate, rational(multiplier));
  const plan = chooseInterpolationPlan(sourceRate, targetRate, options.engine ?? "auto", nativeMultiplierMax, { cfr: true, hagsEnabled: caps.hagsEnabled });
  const duration = ratDiv(rational(frames), sourceRate);
  const outputCount = outputFrameCount(duration, targetRate);
  const expectsGeneration = plan.generatedPerInterval > 0;
  const output = options.output ?? defaultFrameGenOutput(options.input);
  const detail =
    plan.path === "Native DLSSG"
      ? `native ${plan.nativeMultiplier}x, ${plan.generatedPerInterval} generated per interval`
      : plan.path === "Cascade"
        ? `${plan.cascadeStages} x 2x stage(s) on a ${plan.gridMultiplier}x grid, max timing error ${ratToNumber(plan.maximumTemporalError).toFixed(4)} s`
        : "no synthesis, nearest source frame";
  progress(0, `source ${info.width}x${info.height}${rescaled ? ` -> ${width}x${height} (4:2:0 needs even dimensions)` : ""} ${info.codec} ${formatRate(sourceRate)} fps, ${frames} frames; ${plan.path}: -> ${formatRate(targetRate)} fps (${detail}); HAGS ${caps.hagsEnabled ? "on" : "off"}; ${outputCount} output frames`);

  const decoder = Bun.spawn(
    [ffmpeg, "-v", "error", "-nostdin", "-i", options.input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba",
      ...(rescaled ? ["-vf", `scale=${width}:${height}:flags=lanczos`] : []),
      "pipe:1"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  // Only re-open the source as a second input when it actually has audio to carry;
  // otherwise ffmpeg needlessly demuxes/decodes the whole source again.
  const wantAudio = info.hasAudio;
  const audioArgs = wantAudio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"] : ["-an"];
  const outputRate = formatRational(targetRate);
  const resolvedCodec = resolveEncodeCodec(options.codec ?? "h264_nvenc", ffmpeg);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);

  // Prefer in-process NVENC (mux-only ffmpeg, -c:v copy): ffmpeg then muxes a
  // compressed elementary stream instead of ingesting an 8 MB/frame rawvideo
  // pipe. Null for CPU/AV1 codecs, and the worker falls back to the rawvideo
  // args when NVENC will not open. NVENC emits Annex-B and the mp4 muxer
  // converts it to length-prefixed, so `copy` needs no bitstream filter.
  const nativeTarget = nvencNativeTarget(resolvedCodec.codec, width, height);
  // No -shortest: the writer emits exactly ceil(duration * rate) frames, so the
  // video already spans the source duration and the audio track is kept whole.
  // -video_track_timescale = rate numerator makes one frame exactly `den` ticks,
  // so the mp4 timeline is exact and ffprobe's base-rate guess equals the target.
  let sink: EncodeSink;
  try {
    sink = await EncodeSink.open({
      type: "open",
      ffmpeg,
      nvencArgs: nativeTarget
        ? ["-v", "error", "-y", "-f", nativeTarget.demux, "-framerate", outputRate, "-i", "pipe:0", ...(wantAudio ? ["-i", options.input] : []), "-map", "0:v:0", "-c:v", "copy", ...audioArgs, "-video_track_timescale", String(targetRate.num), "-movflags", "+faststart", output]
        : [],
      rawArgs: ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", outputRate, "-i", "pipe:0", ...(wantAudio ? ["-i", options.input] : []), "-map", "0:v:0", ...audioArgs, ...encoderArgs({ codec: resolvedCodec.codec, quality: options.quality ?? 20, container: "mp4", copyAudio: true }), "-video_track_timescale", String(targetRate.num), "-movflags", "+faststart", output],
      nvenc: nativeTarget ? { width, height, fpsNum: Number(targetRate.num), fpsDen: Number(targetRate.den), codec: nativeTarget.codec, cq: options.quality ?? 20 } : null,
    });
  } catch (error) {
    try { decoder.kill(); } catch {}
    await Promise.allSettled([decoder.exited]);
    throw error;
  }
  if (sink.note) progress(0, sink.note);

  // Drain the decoder's stderr for the whole run so it can never fill its pipe,
  // block, and stall the frame loop (the encode worker drains its own).
  let decodeErrText = "";
  const decodeErrDrained = new Response(decoder.stderr as ReadableStream<Uint8Array>).text().then((t) => { decodeErrText = t; }).catch(() => {});

  // Decoded and generated frames live in SharedArrayBuffers so the guide and
  // encode threads read them without copies.
  const reader = new FrameReader(decoder.stdout as ReadableStream<Uint8Array>, true);
  const writer = new NearestTimestampWriter((frame) => sink.write(frame), targetRate, outputCount);
  const zeros = new Uint16Array(width * height * 2);
  const stages: Stage[] = [];
  const capacity = Math.floor((options.bufferLimitBytes ?? DEFAULT_BUFFER_LIMIT) / frameBytes);
  let mode: FrameGenResult["mode"] = "overlapped";
  let inputFrames = 0;
  let peak = 0;

  try {
    const generatedCounts: number[] = [];
    if (plan.path === "Native DLSSG") generatedCounts.push(plan.generatedPerInterval);
    else if (plan.path === "Cascade") for (let stage = 0; stage < plan.cascadeStages; stage++) generatedCounts.push(1);
    // Open every stage's worker process and guide thread concurrently: each
    // brings up its own D3D12/NGX or CUDA/NVOFA context, ~1 s of fixed cost
    // that would otherwise be paid stage by stage.
    const openStage = async (index: number, generatedCount: number): Promise<Stage> => {
      // Stage k sees (frames-1)*2^k + 1 frames: a size hint for the worker's history.
      const frameCount = plan.path === "Cascade" ? Math.max(1, (frames - 1) * (1 << index) + 1) : frames;
      // Only the last stage — 2^(stages-1) evaluations per source frame, the
      // bottleneck — gets a packer thread; the others pack inline so the machine
      // is not oversubscribed.
      const packInline = index !== generatedCounts.length - 1;
      const results = await Promise.allSettled([
        DlssgSession.open(workerDir, { width, height, frameCount, generatedCount, sharedFrames: true }),
        openGuideWorker({ type: "open", width, height, detectSourceCuts: index === 0, packInline }),
        packInline ? Promise.resolve(null) : openGuideWorker({ type: "open-packer", width, height }),
      ]);
      const [sessionResult, guideResult, packerResult] = results;
      if (sessionResult.status === "rejected" || guideResult.status === "rejected" || packerResult.status === "rejected") {
        // Release whatever came up so a partial failure leaks nothing.
        if (sessionResult.status === "fulfilled") await sessionResult.value.close();
        for (const r of [guideResult, packerResult]) if (r.status === "fulfilled" && r.value) try { r.value.worker.terminate(); } catch {}
        throw results.find((r): r is PromiseRejectedResult => r.status === "rejected")!.reason;
      }
      const stage = new Stage(sessionResult.value, guideResult.value.worker, packerResult.value ? packerResult.value.worker : null, generatedCount, zeros);
      stage.flow = guideResult.value.flow === "pack" ? "cpu" : guideResult.value.flow;
      return stage;
    };
    const opened = await Promise.allSettled(generatedCounts.map((generatedCount, index) => openStage(index, generatedCount)));
    for (const result of opened) if (result.status === "fulfilled") stages.push(result.value); // so `finally` closes them
    const failed = opened.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    if (stages.length) progress(0, `guide threads: ${stages.length} + ${stages.filter((s) => s.packer).length} packer, 1 encode (optical flow ${stages.map((s) => (s.flow === "nvof" ? "NVOFA" : "CPU")).join(", ")})`);

    const noneGenerated = () => stages.every((stage) => stage.generatedTotal === 0);
    const check = (): void => {
      // Fail fast before spending the whole encode: nothing synthesised after
      // several real intervals means the runtime has disabled generation.
      if (expectsGeneration && stages[0]!.intervals >= FG_PROBE_INTERVALS && noneGenerated()) throw frameGenDisabledError(plan, stages[0]!.session.disabledFrames, caps.hagsEnabled);
    };
    const params: RunParams = {
      reader,
      frameBytes,
      sourceRate,
      stages,
      writer,
      capacity,
      onProcessed: (count) => progress(Math.min(0.96, count / frames), `frame ${count}/${frames}`, count),
      check,
    };
    const maxGenerated = Math.max(0, ...stages.map((s) => s.generatedCount));
    // Even one input/output transaction may exceed the credit window for enormous frames.
    const sequential = process.env.NR_FRAMEGEN_SEQUENTIAL === "1" || capacity < maxGenerated + 3;
    mode = sequential ? "sequential" : "overlapped";
    if (sequential) progress(0, `pipeline: sequential (${capacity} frame credits)`);
    const runStarted = performance.now();
    const run = sequential ? await runSequential(params) : await runOverlapped(params);
    inputFrames = run.decoded;
    peak = run.peak;
    if (run.busy) {
      // Busy seconds per owner over the run's wall time: the owner closest to the
      // wall time is the bottleneck.
      const wall = (performance.now() - runStarted) / 1000;
      const parts = Object.entries(run.busy).sort(([a], [b]) => a.localeCompare(b)).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}`);
      progress(0.97, `pipeline busy (s) over ${wall.toFixed(1)} s wall: ${parts.join(", ")}`);
    }
    if (inputFrames === 0) throw new Error("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
    // Clips shorter than the probe window still must not pass off a duplicate-frame resample as generation.
    if (expectsGeneration && stages[0]!.intervals >= 1 && noneGenerated()) throw frameGenDisabledError(plan, stages[0]?.session.disabledFrames ?? 0, caps.hagsEnabled);
    await sink.finish();
  } catch (error) {
    // abort() kills the worker's ffmpeg and waits for it to release the output
    // file, so the partial file can be deleted here and a failed job never
    // leaves a misleading one behind.
    try { decoder.kill(); } catch {}
    await sink.abort();
    await Promise.allSettled([decoder.exited, decodeErrDrained]);
    try { if (existsSync(output)) unlinkSync(output); } catch {}
    throw error;
  } finally {
    sink.close();
    for (const stage of stages) await stage.close();
  }

  const decodeExit = await decoder.exited;
  await decodeErrDrained;
  if (decodeExit !== 0) throw new Error(`ffmpeg decode failed (${decodeExit}): ${decodeErrText.trim()}`);

  progress(0.98, "verifying output");
  const verified = probeOutputVideo(ffprobe, output);
  // Packet count and base rate are exact (the track timescale is set above), so
  // they are compared strictly. The average rate is frames / container duration,
  // whose final-frame rounding can be a few ticks off (59.94 lands at
  // 14520000/242237), so it only guards against a grossly wrong timeline.
  const averageOff = Math.abs(ratToNumber(verified.avgRate) / ratToNumber(targetRate) - 1);
  const expectedFrames = writer.outputCount; // may be below the planned outputCount when the container over-declared its frames
  if (verified.frames !== expectedFrames || ratCmp(verified.rate, targetRate) !== 0 || averageOff > 1e-3) {
    try { unlinkSync(output); } catch {}
    throw new Error(
      `Output verification found ${verified.frames} frames at base rate ${formatRational(verified.rate)} fps (average ${formatRational(verified.avgRate)}, time base ${verified.timeBase}); expected ${expectedFrames} at ${outputRate}. The file was removed.`,
    );
  }

  const sceneCuts = stages.reduce((sum, stage) => sum + stage.sceneCuts, 0);
  const droppedFrames = Math.max(0, inputFrames - writer.selectedRealIds.size);
  progress(1, `${plan.path}: ${writer.nextIndex} frames at ${formatRate(targetRate)} fps from ${inputFrames} (${writer.generated} generated, ${writer.copied} copied, ${sceneCuts} scene cut(s))`);
  return {
    output,
    width,
    height,
    sourceFps: ratToNumber(sourceRate),
    outputFps: ratToNumber(targetRate),
    targetFps: formatRate(targetRate),
    path: plan.path,
    nativeMultiplier: plan.nativeMultiplier,
    cascadeStages: plan.cascadeStages,
    multiplier: ratToNumber(ratDiv(targetRate, sourceRate)),
    inputFrames,
    outputFrames: writer.nextIndex,
    copiedFrames: writer.copied,
    generatedFrames: writer.generated,
    droppedFrames,
    sceneCuts,
    maximumTemporalErrorSeconds: ratToNumber(writer.maxError),
    hagsEnabled: caps.hagsEnabled,
    mode,
    peakBufferBytes: peak * frameBytes,
    ms: Math.round(performance.now() - started),
  };
}
