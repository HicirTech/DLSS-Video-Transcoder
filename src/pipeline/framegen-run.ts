/**
 * Runs the frames through the stages. The overlapped coordinator is
 * credit-bounded: one credit is one frame-sized buffer, every possible output
 * is reserved before the work that produces it starts, so no owner can block on
 * a full queue and memory stays under a fixed ceiling. runSequential is the
 * in-order fallback for frames too large for that window.
 */
import { raceAbort, throwIfAborted } from "./cancel.ts";
import type { FrameReader } from "./frame-reader.ts";
import type { NearestTimestampWriter, TimedFrame } from "./framegen-plan.ts";
import type { AnalyzedFrame, PreparedFrame, Stage } from "./framegen-stage.ts";
import { type Rational, ratDiv, rational } from "./rational.ts";
/** What a runner reports back. `peak` is the credit ledger's high-water mark in frame slots, or null from a runner that keeps no ledger. */
export interface RunResult {
  decoded: number;
  peak: number | null;
  busy?: Record<string, number>;
}

export interface RunParams {
  reader: FrameReader;
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
  private readonly done: Array<{ name: string; value?: unknown; error?: Error }> = [];
  private readonly busy: Record<string, number> = {};
  private wake: (() => void) | null = null;
  private used = 0;
  private peak = 0;
  private decoded = 0;
  private decodeSeq = 0;
  private processed = 0;
  private guideSeq = 0;
  private ended = false;

  constructor(private readonly p: RunParams) {
    this.stages = p.stages;
    this.capacity = p.capacity;
    this.maxGenerated = Math.max(0, ...this.stages.map((s) => s.generatedCount));
    this.edgeCapacity = Math.max(4, this.maxGenerated + 1);
    this.edges = Array.from({ length: this.stages.length + 1 }, () => []);
    this.analyzed = this.stages.map(() => []);
    this.prepared = this.stages.map(() => []);
  }

  async run(): Promise<RunResult> {
    const { p } = this;
    // An evaluation blocked on a wedged DLSS-G host never settles, so an abort
    // wakes the loop itself. Left registered: the signal belongs to this job and
    // ends with it, and once the loop is done `wake` is null.
    p.signal?.addEventListener("abort", () => this.wake?.(), { once: true });

    for (;;) {
      throwIfAborted(p.signal);
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
    p.writer.endAt(this.decoded, p.sourceRate);
    await p.writer.finish();
    return { decoded: this.decoded, peak: this.peak, busy: this.busy };
  }

  private reserve(credits: number): void {
    this.used += credits;
    if (this.used > this.capacity) throw new Error("Frame generation buffer reservation exceeded its limit.");
    if (this.used > this.peak) this.peak = this.used;
  }

  private start(name: string, promise: Promise<unknown>): void {
    this.pending.add(name);
    const t0 = performance.now();
    const settle = (): void => { this.busy[name] = (this.busy[name] ?? 0) + (performance.now() - t0); this.pending.delete(name); };
    promise.then(
      (value) => { settle(); this.done.push({ name, value }); this.wake?.(); },
      (error) => { settle(); this.done.push({ name, error: error instanceof Error ? error : new Error(String(error)) }); this.wake?.(); },
    );
  }

  private async decodeOne(): Promise<TimedFrame | null> {
    const index = this.decodeSeq++;
    const rgba = await this.p.reader.next(this.p.frameBytes);
    if (!rgba) return null;
    return { rgba, timestamp: ratDiv(rational(index), this.p.sourceRate), segment: 0, provenance: "Source", sourceIndex: index };
  }

  private async consume(items: TimedFrame[]): Promise<number> {
    for (const item of items) await this.p.writer.push(item);
    return items.length;
  }

  /** Takes in everything that finished. Results own their buffers until consumed. */
  private harvest(): void {
    while (this.done.length) {
      const d = this.done.shift()!;
      if (d.error) throw d.error;
      this.accept(d);
    }
  }

  private accept(d: { name: string; value?: unknown }): void {
    if (d.name === "decode") {
      const frame = d.value as TimedFrame | null;
      if (frame === null) { this.ended = true; this.used -= 1; }
      else {
        this.edges[0]!.push(frame);
        this.decoded++;
        // Without a stage nothing evaluates, so onProcessed would never fire: the decode is the only per-frame step left to report.
        if (this.stages.length === 0) this.p.onProcessed(this.decoded);
      }
    } else if (d.name.startsWith("guide:")) {
      this.analyzed[Number(d.name.slice(6))]!.push(d.value as AnalyzedFrame);
    } else if (d.name.startsWith("pack:")) {
      this.prepared[Number(d.name.slice(5))]!.push(d.value as PreparedFrame);
    } else if (d.name.startsWith("native:")) {
      const k = Number(d.name.slice(7));
      const { items, credits } = d.value as { items: TimedFrame[]; credits: number };
      if (items.length > credits + 1) throw new Error("DLSSG produced more frames than reserved.");
      this.edges[k + 1]!.push(...items);
      this.used -= 2 + credits - items.length;
      if (k === 0) { this.processed++; this.p.onProcessed(this.processed); this.p.check(); }
    } else if (d.name === "encode") {
      this.used -= d.value as number;
    }
  }

  private startEncode(): void {
    const last = this.edges[this.stages.length]!;
    if (!this.pending.has("encode") && last.length) {
      const items = last.splice(0, Math.min(this.edgeCapacity, last.length));
      this.start("encode", this.consume(items));
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
        this.start(name, stage.evaluate(item).then((items) => ({ items, credits: count })));
      }
    }
  }

  private startPacks(): void {
    for (let k = this.stages.length - 1; k >= 0; k--) {
      const name = `pack:${k}`;
      // The analysed item already holds this frame's motion credit; packing just swaps the grid flow for the full field.
      if (!this.pending.has(name) && this.analyzed[k]!.length) {
        const item = this.analyzed[k]!.shift()!;
        this.start(name, this.stages[k]!.pack(item, ++this.guideSeq));
      }
    }
  }

  private startGuides(): void {
    for (let k = this.stages.length - 1; k >= 0; k--) {
      const name = `guide:${k}`;
      // Retain native output headroom even if the GPU is idle; let analysis run a little ahead of packing.
      if (!this.pending.has(name) && this.edges[k]!.length && this.analyzed[k]!.length + this.prepared[k]!.length < 3 && this.used + 1 <= this.capacity - this.maxGenerated) {
        this.reserve(1);
        const frame = this.edges[k]!.shift()!;
        this.start(name, this.stages[k]!.prepare(frame, ++this.guideSeq));
      }
    }
  }

  private startDecode(): void {
    if (!this.ended && !this.pending.has("decode") && this.edges[0]!.length < this.edgeCapacity && this.used + 1 <= this.capacity - this.maxGenerated - 1) {
      this.reserve(1);
      this.start("decode", this.decodeOne());
    }
  }
}


/** Plain in-order fallback for frames too large for the credit window (still uses the guide threads, one step at a time). */
export async function runSequential(p: RunParams): Promise<RunResult> {
  let decoded = 0;
  let guideSeq = 0;
  /** One source frame through every stage into the writer; false at the end of the stream. */
  const step = async (): Promise<boolean> => {
    const rgba = await p.reader.next(p.frameBytes);
    if (!rgba) return false;
    let items: TimedFrame[] = [{ rgba, timestamp: ratDiv(rational(decoded), p.sourceRate), segment: 0, provenance: "Source", sourceIndex: decoded }];
    for (const stage of p.stages) {
      const next: TimedFrame[] = [];
      for (const item of items) next.push(...(await stage.evaluate(await stage.pack(await stage.prepare(item, ++guideSeq), ++guideSeq))));
      items = next;
    }
    for (const item of items) await p.writer.push(item);
    return true;
  };
  for (;;) {
    throwIfAborted(p.signal);
    // Raced as well as checked: a wedged DLSS-G host would block a step forever.
    if (!(await raceAbort(p.signal, step()))) break;
    decoded++;
    p.onProcessed(decoded);
    p.check();
  }
  p.writer.endAt(decoded, p.sourceRate);
  await p.writer.finish();
  // null, not 0: this runner holds frames without a credit ledger, so its peak
  // is unmeasured rather than zero. Reporting 0 put a number nobody measured
  // into the job result as though it had been.
  return { decoded, peak: null };
}
