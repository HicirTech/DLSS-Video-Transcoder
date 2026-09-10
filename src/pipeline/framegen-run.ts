/**
 * Runs the frames through the stages. The overlapped coordinator is
 * credit-bounded: one credit is one frame-sized buffer, every possible output
 * is reserved before the work that produces it starts, so no owner can block on
 * a full queue and memory stays under a fixed ceiling. runSequential is the
 * in-order fallback for frames too large for that window.
 */
import type { FrameReader } from "./frame-reader.ts";
import type { NearestTimestampWriter, TimedFrame } from "./framegen-plan.ts";
import type { AnalyzedFrame, PreparedFrame, Stage } from "./framegen-stage.ts";
import { type Rational, ratAdd, ratDiv, ratMul, ratSub, rational } from "./rational.ts";
export interface RunParams {
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
export async function runOverlapped(p: RunParams): Promise<{ decoded: number; peak: number; busy?: Record<string, number> }> {
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
  p.writer.trimTo(decoded, p.sourceRate);
  await writer.finish();
  return { decoded, peak, busy };
}

/** Plain in-order fallback for frames too large for the credit window (still uses the guide threads, one step at a time). */
export async function runSequential(p: RunParams): Promise<{ decoded: number; peak: number; busy?: Record<string, number> }> {
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
  p.writer.trimTo(decoded, p.sourceRate);
  await p.writer.finish();
  return { decoded, peak: 0 };
}
