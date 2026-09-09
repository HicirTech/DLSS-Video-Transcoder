/**
 * Video frame generation to an exact target frame rate.
 *
 * ffmpeg decodes the source to raw RGBA; every frame gets an exact rational
 * timestamp (index / source rate) and flows through one or more DLSSG stages.
 * A stage pairs a dlssg-worker session with its own optical-flow guide
 * estimator and returns the synthesised in-between frames (timestamped at
 * prev + interval * k/(n+1)) followed by the real frame:
 *
 *   - Native DLSSG: one session generating m-1 frames per interval (m = target
 *     / source, an exact integer the runtime supports; multi-frame needs HAGS).
 *   - Cascade: 2x stages chained IN MEMORY — stage k interpolates between the
 *     frames stage k-1 produced — reaching a 2^stages grid without any
 *     intermediate encode. Reaches 4x/8x on runtimes that only do 2x, and any
 *     non-integer ratio (30 -> 144) via the grid.
 *
 * A NearestTimestampWriter then places exactly ceil(duration * target) frames
 * on the target clock, choosing the nearest available frame for each instant.
 * Because the output count comes from the source DURATION, the result is the
 * same length as the source whatever the worker synthesised (scene cuts, or
 * generation disabled by the runtime), so audio stays in sync and the video
 * can never play too fast. The muxed file is verified (frame count + rate)
 * before it is reported as done.
 *
 * Throughput: the guide work (~12 ms of CPU per evaluation at 720p) runs on
 * one Worker thread per stage, the dlssg-worker processes of all stages evaluate
 * concurrently, and decode / encode overlap with both — a credit-bounded
 * coordinator (reference pipeline.py) keeps memory bounded and frames ordered.
 * A 240 fps cascade (7 evaluations per source frame) was 4.8 source fps when
 * everything ran in series on the main thread.
 *
 * Design ported from the reference project's frame_interpolation package.
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
import { NvencEncoder, probeNvenc } from "./nvenc.ts";
import { type Rational, formatRational, parseRational, ratAdd, ratCmp, ratDiv, ratMul, ratSub, ratToNumber, rational } from "./nut.ts";
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
 * The worker produced no in-between frames. The writer would still emit a
 * correctly timed file, but it would be a plain duplicate-frame resample sold
 * as frame generation, so the job fails with the actual cause instead.
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

/**
 * Once the runtime has refused a native multi-frame session in this process,
 * "auto" goes straight to the cascade for later jobs instead of paying the
 * fail-fast probe again.
 */
let nativeMultiFrameRefused = false;

/**
 * Frame generation with automatic recovery: an "auto" plan that chose native
 * multi-frame and got nothing back (the worker reports generation disabled,
 * seen on this dlssg-worker build even with HAGS on) is re-run as a cascade
 * of 2x stages, which only needs the 2x generation that always works.
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
  half: ArrayBuffer | null;
  sceneCuts: number;
  duplicates: number;
}

/** One DLSSG stage: a worker-process session on the main thread plus a guide Worker thread. */
class Stage {
  sceneCuts = 0;
  duplicates = 0;
  /** Real intervals (no reset) this stage has evaluated. */
  intervals = 0;
  generatedTotal = 0;
  flow: "nvof" | "cpu" | "?" = "?";
  private nextIndex = 0;
  private waiter: { frame: TimedFrame; resolve: (p: PreparedFrame) => void; reject: (e: Error) => void } | null = null;
  private failed: Error | null = null;

  constructor(
    readonly session: DlssgSession,
    readonly guide: Worker,
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
          half: m.half ? new Uint16Array(m.half) : null,
          reset: m.reset,
        });
      } else if (m.type === "error") {
        this.fail(new Error(`frame-generation guide worker: ${m.message}`));
      }
    };
    guide.addEventListener("error", (e) => this.fail(new Error(`frame-generation guide worker crashed: ${(e as ErrorEvent).message}`)));
  }

  private fail(error: Error): void {
    this.failed ??= error;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(error);
  }

  /** Run the guide for one frame on this stage's thread (one at a time, in stream order). */
  prepare(frame: TimedFrame, id: number): Promise<PreparedFrame> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<PreparedFrame>((resolve, reject) => {
      this.waiter = { frame, resolve, reject };
      this.guide.postMessage({ type: "prepare", id, rgba: frame.rgba, segment: frame.segment, tsNum: frame.timestamp.num, tsDen: frame.timestamp.den });
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
    await this.session.close();
  }
}

/** Open a guide worker for a stage and wait until its estimator (and NVOFA session) is up. */
function openGuideWorker(width: number, height: number, detectSourceCuts: boolean): Promise<{ worker: Worker; flow: "nvof" | "cpu" }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workers/framegen-guide-worker.ts", import.meta.url).href);
    const onError = (e: Event) => { reject(new Error(`frame-generation guide worker failed to start: ${(e as ErrorEvent).message}`)); };
    worker.addEventListener("error", onError, { once: true });
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as { type: string; flow?: "nvof" | "cpu"; message?: string };
      if (m.type === "opened") { worker.removeEventListener("error", onError); worker.onmessage = null; resolve({ worker, flow: m.flow ?? "cpu" }); }
      else if (m.type === "error") { reject(new Error(`frame-generation guide worker: ${m.message}`)); }
    };
    worker.postMessage({ type: "open", width, height, detectSourceCuts });
  });
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
 * decode (this thread, async pipe), one guide Worker per stage, one native
 * evaluation per stage (its own dlssg-worker process, so stages overlap on the
 * GPU), and encode (this thread). One credit = one frame-sized buffer. Every
 * possible native output is reserved before an evaluation, and motion storage
 * before a guide, so no owner ever blocks on a queue put; the last stage is
 * served first so the pipeline drains.
 */
async function runOverlapped(p: RunParams): Promise<{ decoded: number; peak: number; busy?: Record<string, number> }> {
  const { stages, writer, capacity } = p;
  const maxGenerated = Math.max(0, ...stages.map((s) => s.generatedCount));
  const edgeCapacity = Math.max(4, maxGenerated + 1);
  const edges: TimedFrame[][] = Array.from({ length: stages.length + 1 }, () => []);
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
        prepared[Number(d.name.slice(6))]!.push(d.value as PreparedFrame);
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
      const name = `guide:${k}`;
      // Retain native output headroom even if the GPU is idle.
      if (!pending.has(name) && edges[k]!.length && prepared[k]!.length < 2 && used + 1 <= capacity - maxGenerated) {
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
      if (ended && edges.every((e) => e.length === 0) && prepared.every((q) => q.length === 0)) break;
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
      for (const item of items) next.push(...(await stage.evaluate(await stage.prepare(item, ++guideSeq))));
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
  const { width, height } = info;
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
  progress(0, `source ${width}x${height} ${info.codec} ${formatRate(sourceRate)} fps, ${frames} frames; ${plan.path}: -> ${formatRate(targetRate)} fps (${detail}); HAGS ${caps.hagsEnabled ? "on" : "off"}; ${outputCount} output frames`);

  const decoder = Bun.spawn([ffmpeg, "-v", "error", "-nostdin", "-i", options.input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  // Only re-open the source as a second input when it actually has audio to carry;
  // otherwise ffmpeg needlessly demuxes/decodes the whole source again.
  const wantAudio = info.hasAudio;
  const audioArgs = wantAudio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"] : ["-an"];
  const outputRate = formatRational(targetRate);
  // GPU encode by default; falls back to CPU libx264 if NVENC will not run.
  const resolvedCodec = resolveEncodeCodec(options.codec ?? "h264_nvenc", ffmpeg);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);

  // Prefer in-process NVENC encode (mux-only ffmpeg, -c:v copy): frames are
  // encoded on the GPU here, so ffmpeg only muxes the compressed stream instead
  // of ingesting an 8 MB/frame rawvideo pipe. Falls back to the rawvideo pipe
  // for CPU/AV1 codecs or when NVENC will not run.
  const nativeTarget = nvencNativeTarget(resolvedCodec.codec, width, height);
  let nvenc: NvencEncoder | null = null;
  if (nativeTarget && probeNvenc(0).available) {
    try {
      nvenc = NvencEncoder.open({ width, height, fpsNum: Number(targetRate.num), fpsDen: Number(targetRate.den), codec: nativeTarget.codec, preset: "p5", cq: options.quality ?? 20 });
      progress(0, `encode: NVENC ${nativeTarget.codec} (GPU, mux-only pipe)`);
    } catch (error) {
      nvenc = null;
      progress(0, `encode: NVENC direct path unavailable (${(error as Error).message}); using rawvideo pipe`);
    }
  }

  const encoder = nvenc
    ? Bun.spawn(
        // NVENC emits Annex-B; the mp4 muxer converts it to length-prefixed. No
        // -shortest: the writer emits exactly ceil(duration * rate) frames, so the
        // video already spans the source duration and the audio track is kept whole.
        // -video_track_timescale = rate numerator: one frame = `den` ticks, so the
        // mp4 timeline is exact and ffprobe's base-rate guess equals the target.
        [ffmpeg, "-v", "error", "-y", "-f", nativeTarget!.demux, "-framerate", outputRate, "-i", "pipe:0", ...(wantAudio ? ["-i", options.input] : []), "-map", "0:v:0", "-c:v", "copy", ...audioArgs, "-video_track_timescale", String(targetRate.num), "-movflags", "+faststart", output],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      )
    : Bun.spawn(
        [ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", outputRate, "-i", "pipe:0", ...(wantAudio ? ["-i", options.input] : []), "-map", "0:v:0", ...audioArgs, ...encoderArgs({ codec: resolvedCodec.codec, quality: options.quality ?? 20, container: "mp4", copyAudio: true }), "-video_track_timescale", String(targetRate.num), "-movflags", "+faststart", output],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      );

  // Drain both ffmpeg stderr streams concurrently for the whole run so neither
  // process can fill its stderr pipe, block, and stall the frame loop.
  let decodeErrText = "";
  let encodeErrText = "";
  const decodeErrDrained = new Response(decoder.stderr as ReadableStream<Uint8Array>).text().then((t) => { decodeErrText = t; }).catch(() => {});
  const encodeErrDrained = new Response(encoder.stderr as ReadableStream<Uint8Array>).text().then((t) => { encodeErrText = t; }).catch(() => {});

  // Decoded and generated frames live in SharedArrayBuffers so the guide threads read them without copies.
  const reader = new FrameReader(decoder.stdout as ReadableStream<Uint8Array>, true);
  const stdin = encoder.stdin as { write(b: Uint8Array): unknown; flush(): number | Promise<number>; end(): unknown };
  // Write with backpressure only; the final stdin.end() flushes the remainder.
  const write = async (frame: Uint8Array): Promise<void> => {
    const payload = nvenc ? nvenc.encode(frame) : frame;
    const w = stdin.write(payload);
    if (w instanceof Promise) await w;
  };
  const writer = new NearestTimestampWriter(write, targetRate, outputCount);
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
    // brings up its own D3D12/NGX or CUDA/NVOFA context (~1 s), which added up
    // to seconds of fixed cost per job when done one after another.
    const openStage = async (index: number, generatedCount: number): Promise<Stage> => {
      // Stage k sees (frames-1)*2^k + 1 frames: a size hint for the worker's history.
      const frameCount = plan.path === "Cascade" ? Math.max(1, (frames - 1) * (1 << index) + 1) : frames;
      const [sessionResult, guideResult] = await Promise.allSettled([
        DlssgSession.open(workerDir, { width, height, frameCount, generatedCount, sharedFrames: true }),
        openGuideWorker(width, height, index === 0),
      ]);
      if (sessionResult.status === "rejected" || guideResult.status === "rejected") {
        // Release whichever half came up so a partial failure leaks nothing.
        if (sessionResult.status === "fulfilled") await sessionResult.value.close();
        if (guideResult.status === "fulfilled") try { guideResult.value.worker.terminate(); } catch {}
        throw sessionResult.status === "rejected" ? sessionResult.reason : (guideResult as PromiseRejectedResult).reason;
      }
      const stage = new Stage(sessionResult.value, guideResult.value.worker, generatedCount, zeros);
      stage.flow = guideResult.value.flow;
      return stage;
    };
    const opened = await Promise.allSettled(generatedCounts.map((generatedCount, index) => openStage(index, generatedCount)));
    for (const result of opened) if (result.status === "fulfilled") stages.push(result.value); // so `finally` closes them
    const failed = opened.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    if (stages.length) progress(0, `guide threads: ${stages.length} (optical flow ${stages.map((s) => (s.flow === "nvof" ? "NVOFA" : "CPU")).join(", ")})`);

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
    if (nvenc) nvenc.finish();
    stdin.end();
  } catch (error) {
    // Tear down both ffmpeg children and remove the partial output so a failed
    // job never leaves a misleading file behind.
    try { decoder.kill(); } catch {}
    try { encoder.kill(); } catch {}
    await Promise.allSettled([decoder.exited, encoder.exited, decodeErrDrained, encodeErrDrained]);
    try { if (existsSync(output)) unlinkSync(output); } catch {}
    throw error;
  } finally {
    nvenc?.close();
    for (const stage of stages) await stage.close();
  }

  const [decodeExit, encodeExit] = await Promise.all([decoder.exited, encoder.exited]);
  await Promise.all([decodeErrDrained, encodeErrDrained]);
  if (decodeExit !== 0) throw new Error(`ffmpeg decode failed (${decodeExit}): ${decodeErrText.trim()}`);
  if (encodeExit !== 0) throw new Error(`ffmpeg encode failed (${encodeExit}): ${encodeErrText.trim()}`);

  // Verify the muxed file really carries the planned timeline before calling it done.
  progress(0.98, "verifying output");
  const verified = probeOutputVideo(ffprobe, output);
  // Exact packet count and exact base rate (reliable now that the track
  // timescale is explicit). The average rate is frames / container duration,
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
