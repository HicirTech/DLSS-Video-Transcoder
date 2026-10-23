/**
 * Runs the frames through the stages. The overlapped coordinator is
 * credit-bounded: one credit is one frame-sized buffer, every possible output
 * is reserved before the work that produces it starts, so no owner can block on
 * a full queue and memory stays under a fixed ceiling. runSequential is the
 * in-order fallback for frames too large for that window.
 */
import { raceAbort, throwIfAborted } from "./cancel.ts";
import type { FrameSource } from "./frame-reader.ts";
import type { AnalyzedFrame, PreparedFrame, Stage } from "./framegen-stage.ts";
import type { NearestTimestampWriter, TimedFrame } from "./nearest-timestamp-writer.ts";
import { type Rational, ratDiv, rational } from "./rational.ts";

/** Credits a source frame holds until its evaluation: its decoded buffer (startDecode) and its motion storage (startGuides). */
const SOURCE_FRAME_CREDITS = 2;
/** Fewest frames an edge queue holds, however few the stages generate: the reference pipeline.py's edge_capacity = max(4, max_generated + 1). */
const MIN_EDGE_CAPACITY = 4;
/** Analysed and packed frames a stage may hold ahead of its evaluation, so analysis runs a little ahead of packing. */
const MAX_FRAMES_AHEAD = 3;
/** Credits a decode leaves free beyond the native output headroom, so the guide for the frame it decodes can always start. */
const DECODE_HEADROOM_CREDITS = 1;

/** What a runner reports back. `peak` is the credit ledger's high-water mark in frame slots, or null from a runner that keeps no ledger. */
export interface RunResult {
  decoded: number;
  peak: number | null;
  busy?: Record<string, number>;
}

export interface RunParams {
  reader: FrameSource;
  frameBytes: number;
  sourceRate: Rational;
  stages: Stage[];
  writer: NearestTimestampWriter;
  capacity: number;
  /** Called with the number of source frames stage 0 has evaluated, or decoded when the plan has no stage. */
  onProcessed: (count: number) => void;
  /** Throws when the run should abort (e.g. nothing generated after enough intervals); called after each stage-0 evaluation. */
  check: () => void;
  /** Cooperative cancellation: checked on every turn of the frame loop, including runs with no DLSSG stage. */
  signal?: AbortSignal;
}

/** The most frames one evaluation of any stage generates, so the most output credits one evaluation reserves. */
function maxGeneratedCount(stages: Stage[]): number {
  return Math.max(0, ...stages.map((stage) => stage.generatedCount));
}

/**
 * Whether runOverlapped can make progress in `capacity` credits. The bound is the reference pipeline.py's
 * `capacity < max_generated + 3` fallback, carried over: for enormous frames even one input/output transaction may
 * not fit the window.
 */
export function fitsOverlapped(stages: Stage[], capacity: number): boolean {
  return capacity >= maxGeneratedCount(stages) + 3;
}

/** A decoded buffer as the source frame at `index`: timestamp index / sourceRate, segment 0. */
function sourceFrame(rgba: Uint8Array, index: number, sourceRate: Rational): TimedFrame {
  return { rgba, timestamp: ratDiv(rational(index), sourceRate), segment: 0, provenance: "Source", sourceIndex: index };
}

/**
 * Credit-bounded coordinator (reference pipeline.py, overlapped mode). Owners:
 * decode (this thread, async pipe), one guide Worker per stage (guide analysis
 * costs ~12 ms of CPU per frame at 720p, far too much for this thread), one
 * native evaluation per stage (its own DLSS-G host process, so stages overlap
 * on the GPU), and encode (its own Worker).
 *
 * One credit = one frame-sized buffer. Every possible native output is reserved
 * before an evaluation, and motion storage before a guide, so no owner ever
 * blocks on a queue put; the last stage is served first so the pipeline drains.
 */
export async function runOverlapped(p: RunParams): Promise<RunResult> {
  return new OverlappedRun(p).run();
}

/** The queues, credit ledger and pending work of one overlapped run; every method is one step of the coordinator loop. */
class OverlappedRun {
  private readonly stages: Stage[];
  private readonly capacity: number;
  private readonly maxGenerated: number;
  private readonly edgeCapacity: number;
  private readonly edges: TimedFrame[][];
  private readonly analyzed: AnalyzedFrame[][];
  private readonly prepared: PreparedFrame[][];
  private readonly pending = new Set<string>();
  /** Settled work in completion order: a handler for its value, or its error. */
  private readonly done: Array<{ apply: () => void } | { error: Error }> = [];
  private readonly busy: Record<string, number> = {};
  private wake: (() => void) | null = null;
  private used = 0;
  private peak = 0;
  private decoded = 0;
  private decodeSeq = 0;
  private processed = 0;
  private guideSeq = 0;
  private ended = false;

  constructor(private readonly params: RunParams) {
    this.stages = params.stages;
    this.capacity = params.capacity;
    this.maxGenerated = maxGeneratedCount(this.stages);
    this.edgeCapacity = Math.max(MIN_EDGE_CAPACITY, this.maxGenerated + 1);
    this.edges = Array.from({ length: this.stages.length + 1 }, () => []);
    this.analyzed = this.stages.map(() => []);
    this.prepared = this.stages.map(() => []);
  }

  async run(): Promise<RunResult> {
    const { params } = this;
    // An evaluation blocked on a wedged DLSS-G host never settles, so an abort
    // wakes the loop itself. Left registered: the signal belongs to this job and
    // ends with it, and once the loop is done `wake` is null.
    params.signal?.addEventListener("abort", () => this.wake?.(), { once: true });

    for (;;) {
      throwIfAborted(params.signal);
      this.harvest();
      this.startEncode();
      this.startEvaluations();
      this.startPacks();
      this.startGuides();
      this.startDecode();

      if (this.pending.size === 0) {
        if (this.ended && this.edges.every((e) => e.length === 0) && this.analyzed.every((q) => q.length === 0) && this.prepared.every((q) => q.length === 0)) break;
        throw new Error("Frame generation could not drain its bounded pipeline.");
      }
      if (this.done.length === 0) await new Promise<void>((resolve) => { this.wake = () => { this.wake = null; resolve(); }; });
    }
    params.writer.endAt(this.decoded, params.sourceRate);
    await params.writer.finish();
    return { decoded: this.decoded, peak: this.peak, busy: this.busy };
  }

  private reserve(credits: number): void {
    this.used += credits;
    if (this.used > this.capacity) throw new Error("Frame generation buffer reservation exceeded its limit.");
    if (this.used > this.peak) this.peak = this.used;
  }

  /** Runs `promise` as the pending work `name`; harvest() hands its value to `onValue`, or throws its error. */
  private start<T>(name: string, promise: Promise<T>, onValue: (value: T) => void): void {
    this.pending.add(name);
    const t0 = performance.now();
    const settle = (): void => { this.busy[name] = (this.busy[name] ?? 0) + (performance.now() - t0); this.pending.delete(name); };
    promise.then(
      (value) => { settle(); this.done.push({ apply: () => onValue(value) }); this.wake?.(); },
      (error) => { settle(); this.done.push({ error: error instanceof Error ? error : new Error(String(error)) }); this.wake?.(); },
    );
  }

  private async decodeOne(): Promise<TimedFrame | null> {
    const index = this.decodeSeq++;
    const rgba = await this.params.reader.next(this.params.frameBytes);
    if (!rgba) return null;
    return sourceFrame(rgba, index, this.params.sourceRate);
  }

  private async consume(items: TimedFrame[]): Promise<number> {
    for (const item of items) await this.params.writer.push(item);
    return items.length;
  }

  /** Takes in everything that finished. Results own their buffers until consumed. */
  private harvest(): void {
    while (this.done.length) {
      const completed = this.done.shift()!;
      if ("error" in completed) throw completed.error;
      completed.apply();
    }
  }

  private acceptDecode(frame: TimedFrame | null): void {
    if (frame === null) {
      this.ended = true;
      this.used -= 1;
      return;
    }
    this.edges[0]!.push(frame);
    this.decoded++;
    // Without a stage nothing evaluates, so onProcessed would never fire: the decode is the only per-frame step left to report.
    if (this.stages.length === 0) this.params.onProcessed(this.decoded);
  }

  /** Takes in an evaluation of stage `stageIndex` that reserved `credits` output credits. */
  private acceptEvaluation(stageIndex: number, items: TimedFrame[], credits: number): void {
    if (items.length > credits + 1) throw new Error("DLSSG produced more frames than reserved.");
    this.edges[stageIndex + 1]!.push(...items);
    this.used -= SOURCE_FRAME_CREDITS + credits - items.length;
    if (stageIndex === 0) {
      this.processed++;
      this.params.onProcessed(this.processed);
      this.params.check();
    }
  }

  private startEncode(): void {
    const last = this.edges[this.stages.length]!;
    if (!this.pending.has("encode") && last.length) {
      const items = last.splice(0, Math.min(this.edgeCapacity, last.length));
      this.start("encode", this.consume(items), (released) => { this.used -= released; });
    }
  }

  private startEvaluations(): void {
    for (let k = this.stages.length - 1; k >= 0; k--) {
      const stage = this.stages[k]!;
      const count = stage.generatedCount;
      const name = `native:${k}`;
      if (!this.pending.has(name) && this.prepared[k]!.length && this.used + count <= this.capacity && this.edges[k + 1]!.length + count + 1 <= this.edgeCapacity) {
        this.reserve(count);
        const item = this.prepared[k]!.shift()!;
        this.start(name, stage.evaluate(item), (items) => this.acceptEvaluation(k, items, count));
      }
    }
  }

  private startPacks(): void {
    for (let k = this.stages.length - 1; k >= 0; k--) {
      const name = `pack:${k}`;
      // The analysed item already holds this frame's motion credit; packing just swaps the grid flow for the full field.
      if (!this.pending.has(name) && this.analyzed[k]!.length) {
        const item = this.analyzed[k]!.shift()!;
        this.start(name, this.stages[k]!.pack(item, ++this.guideSeq), (packed) => { this.prepared[k]!.push(packed); });
      }
    }
  }

  private startGuides(): void {
    for (let k = this.stages.length - 1; k >= 0; k--) {
      const name = `guide:${k}`;
      // Retain native output headroom even if the GPU is idle.
      if (!this.pending.has(name) && this.edges[k]!.length && this.analyzed[k]!.length + this.prepared[k]!.length < MAX_FRAMES_AHEAD && this.used + 1 <= this.capacity - this.maxGenerated) {
        this.reserve(1);
        const frame = this.edges[k]!.shift()!;
        this.start(name, this.stages[k]!.prepare(frame, ++this.guideSeq), (analyzed) => { this.analyzed[k]!.push(analyzed); });
      }
    }
  }

  private startDecode(): void {
    if (!this.ended && !this.pending.has("decode") && this.edges[0]!.length < this.edgeCapacity && this.used + 1 <= this.capacity - this.maxGenerated - DECODE_HEADROOM_CREDITS) {
      this.reserve(1);
      this.start("decode", this.decodeOne(), (frame) => this.acceptDecode(frame));
    }
  }
}


/** Plain in-order fallback for frames too large for the credit window (still uses the guide threads, one step at a time). */
export async function runSequential(params: RunParams): Promise<RunResult> {
  let decoded = 0;
  let guideSeq = 0;
  /** One source frame through every stage into the writer; false at the end of the stream. */
  const step = async (): Promise<boolean> => {
    const rgba = await params.reader.next(params.frameBytes);
    if (!rgba) return false;
    let items: TimedFrame[] = [sourceFrame(rgba, decoded, params.sourceRate)];
    for (const stage of params.stages) {
      const next: TimedFrame[] = [];
      for (const item of items) next.push(...(await stage.evaluate(await stage.pack(await stage.prepare(item, ++guideSeq), ++guideSeq))));
      items = next;
    }
    for (const item of items) await params.writer.push(item);
    return true;
  };
  for (;;) {
    throwIfAborted(params.signal);
    // Raced as well as checked: a wedged DLSS-G host would block a step forever.
    if (!(await raceAbort(params.signal, step()))) break;
    decoded++;
    params.onProcessed(decoded);
    params.check();
  }
  params.writer.endAt(decoded, params.sourceRate);
  await params.writer.finish();
  // null, not 0: this runner holds frames without a credit ledger, so its peak
  // is unmeasured rather than zero. Reporting 0 put a number nobody measured
  // into the job result as though it had been.
  return { decoded, peak: null };
}
