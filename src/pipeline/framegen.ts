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
 * Design ported from the reference project's frame_interpolation package.
 */
import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { EncodeSettings } from "../server/api-types.ts";
import { DlssgSession, probeDlssg } from "./dlssg.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { createMotionEstimator, encodeMotionR16G16, type MotionEstimator, type MotionResult } from "./flow.ts";
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
import { tryCreateNvofBackend } from "./nvof.ts";
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
  ms: number;
}

export function defaultFrameGenOutput(input: string): string {
  const ext = extname(input);
  return join(dirname(input), `${basename(input, ext)}.dlssg.mp4`);
}

/** Real inter-frame intervals to tolerate with zero synthesised frames before concluding generation is disabled. */
const FG_PROBE_INTERVALS = 8;

/**
 * The worker produced no in-between frames. The writer would still emit a
 * correctly timed file, but it would be a plain duplicate-frame resample sold
 * as frame generation, so the job fails with the actual cause instead.
 */
function frameGenDisabledError(plan: InterpolationPlan, disabledFrames: number, hagsEnabled: boolean): Error {
  const wanted = `${formatRate(plan.sourceRate)} -> ${formatRate(plan.targetRate)} fps via ${plan.path}`;
  const reported = disabledFrames ? `; the worker reported generation disabled for ${disabledFrames} frame(s)` : "";
  const hint =
    plan.path === "Native DLSSG" && plan.generatedPerInterval >= 2 && !hagsEnabled
      ? " Multi-frame (3x and above) DLSS Frame Generation requires Windows hardware-accelerated GPU scheduling (HAGS), which is off on this machine: enable it under Settings > System > Display > Graphics > Default graphics settings and reboot, or use the cascade engine (auto already prefers cascade while HAGS is off)."
      : " Check that the GPU driver is current and the dlssg runtime folder is complete; the cascade engine only needs 2x generation.";
  return new Error(`DLSS Frame Generation produced no interpolated frames (${wanted})${reported}.${hint} No output was written.`);
}

interface PreparedFrame {
  frame: TimedFrame;
  previousTimestamp: Rational | null;
  guide: MotionResult;
  reset: boolean;
}

/** One dlssg-worker session plus its own guide history (reference processor.py DLSSGStage). */
class DlssgStage {
  previous: TimedFrame | null = null;
  sceneCuts = 0;
  duplicates = 0;
  /** Real intervals (no reset) this stage has evaluated. */
  intervals = 0;
  generatedTotal = 0;
  private nextIndex = 0;

  constructor(
    readonly session: DlssgSession,
    private readonly estimator: MotionEstimator,
    private readonly zeros: Uint16Array,
    readonly generatedCount: number,
    private readonly detectSourceCuts: boolean,
  ) {}

  prepare(input: TimedFrame): PreparedFrame {
    const previous = this.previous;
    let frame = input;
    // A segment change (timestamp discontinuity, or a cut found by an earlier stage) is a known reset.
    let forceReset = previous !== null && frame.segment !== previous.segment;
    const guide = this.estimator.process(frame.rgba, forceReset);
    // Only the first stage discovers scene cuts; it starts a new segment so later stages inherit the decision.
    if (previous !== null && this.detectSourceCuts && guide.reset && !forceReset) {
      frame = { ...frame, segment: previous.segment + 1 };
      forceReset = true;
      this.sceneCuts++;
    }
    if (previous !== null && guide.duplicate) this.duplicates++;
    this.previous = frame;
    const reset = previous === null || forceReset || guide.reset;
    if (!reset) this.intervals++;
    return { frame, previousTimestamp: previous ? previous.timestamp : null, guide, reset };
  }

  /** Synthesised frames that precede the real frame, then the real frame itself. */
  async evaluate(prepared: PreparedFrame): Promise<TimedFrame[]> {
    const { frame } = prepared;
    const motion = prepared.guide.motion ? encodeMotionR16G16(prepared.guide.motion) : this.zeros;
    const generated = await this.session.processFrame(frame.rgba, motion, this.nextIndex++, prepared.reset, frame.timestamp.num, frame.timestamp.den);
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

  close(): void {
    this.estimator.close();
  }
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

export async function processFrameGen(options: FrameGenOptions): Promise<FrameGenResult> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  if (!ffmpeg || !ffprobe)
    throw new Error("ffmpeg and ffprobe are required for frame generation (install with `winget install Gyan.FFmpeg` or set FFMPEG_PATH / FFPROBE_PATH).");

  const workerDir = join(options.runtimeDir, "dlssg");
  const caps = await probeDlssg(workerDir);
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

  const reader = new FrameReader(decoder.stdout as ReadableStream<Uint8Array>);
  const stdin = encoder.stdin as { write(b: Uint8Array): unknown; flush(): number | Promise<number>; end(): unknown };
  // Write with backpressure only; the final stdin.end() flushes the remainder.
  const write = async (frame: Uint8Array): Promise<void> => {
    const payload = nvenc ? nvenc.encode(frame) : frame;
    const w = stdin.write(payload);
    if (w instanceof Promise) await w;
  };
  const writer = new NearestTimestampWriter(write, targetRate, outputCount);
  const zeros = new Uint16Array(width * height * 2);
  const sessions: DlssgSession[] = [];
  const stages: DlssgStage[] = [];
  let inputFrames = 0;
  let flowNote: string | null = null;

  try {
    if (plan.path === "Native DLSSG") {
      sessions.push(await DlssgSession.open(workerDir, { width, height, frameCount: frames, generatedCount: plan.generatedPerInterval }));
    } else if (plan.path === "Cascade") {
      for (let stage = 0; stage < plan.cascadeStages; stage++) {
        // Stage k sees (frames-1)*2^k + 1 frames: a size hint for the worker's history.
        sessions.push(await DlssgSession.open(workerDir, { width, height, frameCount: Math.max(1, (frames - 1) * (1 << stage) + 1), generatedCount: 1 }));
      }
    }
    for (const [index, session] of sessions.entries()) {
      // Every stage keeps its own temporal history, so each gets its own estimator
      // (GPU NVOFA when available, else the CPU block matcher).
      const nvof = tryCreateNvofBackend(width, height);
      if (flowNote === null) flowNote = nvof ? "optical flow: NVIDIA hardware (NVOFA)" : "optical flow: CPU block matching (NVOFA unavailable)";
      const estimator = createMotionEstimator(width, height, nvof ? { backend: nvof } : {});
      stages.push(new DlssgStage(session, estimator, zeros, plan.path === "Native DLSSG" ? plan.generatedPerInterval : 1, index === 0));
    }
    if (flowNote) progress(0, flowNote);

    const noneGenerated = () => stages.every((stage) => stage.generatedTotal === 0);
    for (;;) {
      const rgba = await reader.next(frameBytes);
      if (!rgba) break;
      let items: TimedFrame[] = [{ rgba, timestamp: ratDiv(rational(inputFrames), sourceRate), segment: 0, provenance: "Source", sourceIndex: inputFrames }];
      // Sequential cascade: every frame stage k emits (generated + real) feeds stage k+1.
      for (const stage of stages) {
        const next: TimedFrame[] = [];
        for (const item of items) next.push(...(await stage.evaluate(stage.prepare(item))));
        items = next;
      }
      // Fail fast before spending the whole encode: nothing synthesised after
      // several real intervals means the runtime has disabled generation.
      if (expectsGeneration && stages[0]!.intervals >= FG_PROBE_INTERVALS && noneGenerated()) throw frameGenDisabledError(plan, sessions[0]!.disabledFrames, caps.hagsEnabled);
      for (const item of items) await writer.push(item);
      inputFrames++;
      progress(Math.min(0.96, inputFrames / frames), `frame ${inputFrames}/${frames}`, inputFrames);
    }
    if (inputFrames === 0) throw new Error("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
    // Clips shorter than the probe window still must not pass off a duplicate-frame resample as generation.
    if (expectsGeneration && stages[0]!.intervals >= 1 && noneGenerated()) throw frameGenDisabledError(plan, sessions[0]?.disabledFrames ?? 0, caps.hagsEnabled);
    await writer.finish();
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
    for (const stage of stages) stage.close();
    for (const session of sessions) await session.close();
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
  if (verified.frames !== outputCount || ratCmp(verified.rate, targetRate) !== 0 || averageOff > 1e-3) {
    try { unlinkSync(output); } catch {}
    throw new Error(
      `Output verification found ${verified.frames} frames at base rate ${formatRational(verified.rate)} fps (average ${formatRational(verified.avgRate)}, time base ${verified.timeBase}); expected ${outputCount} at ${outputRate}. The file was removed.`,
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
    ms: Math.round(performance.now() - started),
  };
}
