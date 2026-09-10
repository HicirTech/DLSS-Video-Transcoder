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
import { EncodeSink, buildFrameGenEncodeArgs } from "./framegen-encode-sink.ts";
import { FrameReader } from "./frame-reader.ts";
import { type RunParams, runOverlapped, runSequential } from "./framegen-run.ts";
import { Stage, openGuideWorker } from "./framegen-stage.ts";
import { verifyOutputVideo } from "./framegen-verify.ts";
import {
  type FrameGenEngine,
  type InterpolationPlan,
  NearestTimestampWriter,
  chooseInterpolationPlan,
  formatRate,
  outputFrameCount,
  resolveTargetRate,
} from "./framegen-plan.ts";
import type { NvencSdkCodec } from "./nvenc.ts";
import { parseRational, ratDiv, ratMul, ratToNumber, rational } from "./rational.ts";
import { evenSize } from "./resize.ts";
import { findTool } from "./tools.ts";
import { probeVideo } from "./video.ts";

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
  /** "overlapped" (threads + concurrent stages) or "sequential" (fallback for frames too large for the buffer limit). */
  mode: "overlapped" | "sequential";
  /** Peak bytes of frames in flight. */
  peakBufferBytes: number;
  ms: number;
}

function defaultFrameGenOutput(input: string): string {
  const ext = extname(input);
  return join(dirname(input), `${basename(input, ext)}.dlssg.mp4`);
}

/** Real inter-frame intervals to tolerate with zero synthesised frames before concluding generation is disabled. */
const FG_PROBE_INTERVALS = 8;
const DEFAULT_BUFFER_LIMIT = 1 << 30;

/** Raised when the worker synthesised nothing; carries the plan so "auto" can retry with a cascade. Caught in processFrameGen below, nowhere else. */
class FrameGenDisabledError extends Error {
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

/** Runtime folders whose worker has refused a native multi-frame session in this process; "auto" skips the fail-fast probe for those. */
const nativeMultiFrameRefused = new Set<string>();

/**
 * An "auto" plan that chose native multi-frame and got nothing back is re-run
 * as a cascade of 2x stages, which only needs the 2x generation that always
 * works. This dlssg-worker build reports generation disabled for 3x and above
 * even with HAGS on, so the retry is the normal path, not an edge case.
 */
export async function processFrameGen(options: FrameGenOptions): Promise<FrameGenResult> {
  const engine = options.engine ?? "auto";
  const workerDir = join(options.runtimeDir, "dlssg");
  if (engine === "auto" && nativeMultiFrameRefused.has(workerDir)) return processFrameGenOnce({ ...options, engine: "cascade" });
  try {
    return await processFrameGenOnce(options);
  } catch (error) {
    if (engine === "auto" && error instanceof FrameGenDisabledError && error.plan.path === "Native DLSSG" && error.plan.generatedPerInterval >= 2) {
      nativeMultiFrameRefused.add(workerDir);
      options.onProgress?.(0, `native ${error.plan.nativeMultiplier}x refused by the runtime (no frames synthesised); falling back to a cascade of 2x stages`);
      return processFrameGenOnce({ ...options, engine: "cascade" });
    }
    throw error;
  }
}

/** A frame after its stage's guide worker ran: what the native evaluation needs. */
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
  const resolvedCodec = resolveEncodeCodec(options.codec ?? "h264_nvenc", ffmpeg);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);

  let sink: EncodeSink;
  try {
    sink = await EncodeSink.open(
      buildFrameGenEncodeArgs({
        ffmpeg,
        input: options.input,
        output,
        width,
        height,
        targetRate,
        codec: resolvedCodec.codec,
        quality: options.quality ?? 20,
        hasAudio: wantAudio,
      }),
    );
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
  const capacity = Math.floor(DEFAULT_BUFFER_LIMIT / frameBytes);
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
      stage.flowReason = guideResult.value.flowReason;
      return stage;
    };
    const opened = await Promise.allSettled(generatedCounts.map((generatedCount, index) => openStage(index, generatedCount)));
    for (const result of opened) if (result.status === "fulfilled") stages.push(result.value); // so `finally` closes them
    const failed = opened.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    if (stages.length) progress(0, `guide threads: ${stages.length} + ${stages.filter((s) => s.packer).length} packer, 1 encode (optical flow ${stages.map((s) => (s.flow === "nvof" ? "NVOFA" : "CPU")).join(", ")})`);
    // Every stage asks for the same grid, so one report covers all of them.
    const flowReason = stages.find((s) => s.flowReason)?.flowReason;
    if (flowReason) progress(0, flowReason);

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
    await Promise.allSettled(stages.map((stage) => stage.close()));
  }

  const decodeExit = await decoder.exited;
  await decodeErrDrained;
  if (decodeExit !== 0) throw new Error(`ffmpeg decode failed (${decodeExit}): ${decodeErrText.trim()}`);

  progress(0.98, "verifying output");
  // writer.outputCount, not the planned count: trimTo lowers it when the
  // container over-declared how many frames it holds.
  verifyOutputVideo(ffprobe, output, targetRate, writer.outputCount);

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
