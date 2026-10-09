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
 * What sets the output length is explained at NearestTimestampWriter
 * (framegen-plan.ts). The muxed file is verified (frame count + rate) before
 * the job reports success.
 *
 * Ported from the reference project's frame_interpolation package.
 */
import { existsSync } from "node:fs";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_FRAME_GEN_MULTIPLIER, type EncodeSettings, FRAME_GEN_CONTAINER, type FrameGenEngine } from "../server/api-types.ts";
import { throwIfAborted } from "./cancel.ts";
import { DlssgSession, probeDlssg } from "./dlssg.ts";
import { motionFieldBytes } from "./dlssg-protocol.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { decodeArgv } from "./ffmpeg-args.ts";
import { ffmpegFailedMessage, NoFramesDecodedError } from "./ffmpeg-failure.ts";
import { EncodeSink, buildFrameGenEncodeArgs } from "./framegen-encode-sink.ts";
import { noFramesGeneratedMessage } from "./framegen-host-messages.ts";
import { estimatedFrameProgress, type ProgressReporter } from "./frame-progress.ts";
import { FrameReader } from "./frame-reader.ts";
import { type RunParams, runOverlapped, runSequential } from "./framegen-run.ts";
import { defaultOutputPath } from "./output-path.ts";
import { removePartialOutput } from "./partial-output.ts";
import { Stage, openGuideWorker } from "./framegen-stage.ts";
import { verifyOutputVideo } from "./framegen-verify.ts";
import {
  FRAMEGEN_CUDA_DEVICE,
  type InterpolationPlan,
  NearestTimestampWriter,
  chooseInterpolationPlan,
  formatRate,
  isNativeMultiFramePlan,
  resolveTargetRate,
} from "./framegen-plan.ts";
import { type Rational, parseRational, ratDiv, ratMul, ratToNumber, rational } from "./rational.ts";
import { evenSize } from "./resize.ts";
import { requireFfmpegTools } from "./tools.ts";
import { type VideoInfo, probeVideo } from "./video-probe.ts";
import { ABORT_TIMEOUT_MS } from "./worker-abort.ts";

export interface FrameGenOptions {
  input: string;
  output?: string;
  /**
   * Output frame rate: a named rate ("60", "59.94", "120", "144", ... see
   * FRAME_GEN_FPS_CHOICES), an exact "num/den", or a decimal. Takes precedence over
   * `multiplier` when both are given.
   */
  targetFps?: string;
  /** Convenience when `targetFps` is absent: output = source rate x multiplier, a whole number (2 = double the fps). Default DEFAULT_FRAME_GEN_MULTIPLIER. */
  multiplier?: number;
  /**
   * auto: native multi-frame when the ratio is an exact integer the runtime
   * supports AND HAGS is on, otherwise a cascade of 2x stages. native / cascade
   * force that path. Default auto.
   */
  engine?: FrameGenEngine;
  runtimeDir: string;
  /** Default DEFAULT_ENCODE_SETTINGS.quality. */
  quality?: number;
  /** Output codec; default DEFAULT_ENCODE_SETTINGS.codec, which falls back to its CPU sibling when NVENC cannot start. */
  codec?: EncodeSettings["codec"];
  onProgress?: ProgressReporter;
  /** Cooperative cancellation (see cancel.ts): checked on every turn of the frame loop until the encode is finishing, which then completes. */
  signal?: AbortSignal;
  /** Called once as the run starts finishing; see VideoJobOptions.onFinishing. */
  onFinishing?: () => void;
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
  /** Peak bytes of frames in flight, or null when the run used the sequential fallback, which keeps no credit ledger. */
  peakBufferBytes: number | null;
  ms: number;
}

/** Real inter-frame intervals to tolerate with zero synthesised frames before concluding generation is disabled. */
const FG_PROBE_INTERVALS = 8;
/**
 * Ceiling, in bytes, on the frame buffers the overlapped runner holds at once. One credit is one
 * frame-sized buffer (framegen-run.ts), so a run gets floor(limit / frameBytes) credits (129 at
 * 1080p, 32 at 2160p), and a frame so large that fewer than maxGenerated + 3 credits fit runs on
 * the sequential runner instead. No option changes it. 1 GiB is the reference pipeline.py's
 * BUFFER_LIMIT_BYTES carried over, not a value measured for this program.
 */
const DEFAULT_BUFFER_LIMIT = 1 << 30;

/** Raised when the host synthesised nothing; carries the plan so "auto" can retry with a cascade. Caught in processFrameGen below, nowhere else. */
class FrameGenDisabledError extends Error {
  constructor(message: string, readonly plan: InterpolationPlan) {
    super(message);
    this.name = "FrameGenDisabledError";
  }
}

/** Runtime folders whose host has refused a native multi-frame session in this process; "auto" skips the fail-fast probe for those. */
const nativeMultiFrameRefused = new Set<string>();

/**
 * Engine "auto" plans one native session when the ratio is an exact integer up to the runtime's
 * maximum, from 3x up only with HAGS on, and a cascade of 2x stages otherwise (framegen-plan.ts). A
 * native multi-frame session that got nothing back is re-run as a cascade, which only needs 2x
 * generation; the runtime folder is remembered, so its later "auto" jobs start as a cascade.
 */
export async function processFrameGen(options: FrameGenOptions): Promise<FrameGenResult> {
  const engine = options.engine ?? "auto";
  if (engine === "auto" && nativeMultiFrameRefused.has(options.runtimeDir)) return processFrameGenOnce({ ...options, engine: "cascade" });
  try {
    return await processFrameGenOnce(options);
  } catch (error) {
    if (engine === "auto" && error instanceof FrameGenDisabledError && isNativeMultiFramePlan(error.plan)) {
      nativeMultiFrameRefused.add(options.runtimeDir);
      options.onProgress?.(0, `native ${error.plan.nativeMultiplier}x refused by the runtime (no frames synthesised); falling back to a cascade of 2x stages`);
      return processFrameGenOnce({ ...options, engine: "cascade" });
    }
    throw error;
  }
}

/** What the source and the runtime allow, settled before anything is spawned. */
interface FrameGenJob {
  options: FrameGenOptions;
  progress: NonNullable<FrameGenOptions["onProgress"]>;
  ffmpeg: string;
  ffprobe: string;
  caps: Awaited<ReturnType<typeof probeDlssg>>;
  info: VideoInfo;
  width: number;
  height: number;
  frameBytes: number;
  sourceRate: Rational;
  targetRate: Rational;
  plan: InterpolationPlan;
  expectedDecoded: number;
  expectsGeneration: boolean;
  output: string;
  /** Whether the destination existed before the job: it decides what a failure may delete. */
  outputExisted: boolean;
}

/** What the frame loop reports once the pipeline has run. */
interface PipelineRun {
  mode: FrameGenResult["mode"];
  inputFrames: number;
  /** null until a runner reports one; the sequential fallback keeps no ledger. */
  peak: number | null;
}

/** One attempt at a job; processFrameGen re-runs it as a cascade when a native session turns out to be disabled. */
async function processFrameGenOnce(options: FrameGenOptions): Promise<FrameGenResult> {
  const started = performance.now();
  const job = await planFrameGen(options);
  const { width, height, frameBytes, targetRate, output, outputExisted } = job;
  const { decoder, sink } = await openEncodePipeline(job);

  // Drain the decoder's stderr for the whole run so it can never fill its pipe,
  // block, and stall the frame loop (the encode worker drains its own).
  let decodeErrText = "";
  const decodeErrDrained = new Response(decoder.stderr as ReadableStream<Uint8Array>).text().then((t) => { decodeErrText = t; }).catch(() => {});

  // Decoded and generated frames live in SharedArrayBuffers so the guide and
  // encode threads read them without copies.
  const reader = new FrameReader(decoder.stdout as ReadableStream<Uint8Array>, true);
  const writer = new NearestTimestampWriter((frame) => sink.write(frame), targetRate);
  const zeros = new Uint16Array(motionFieldBytes(width, height) / Uint16Array.BYTES_PER_ELEMENT);
  const stages: Stage[] = [];
  // Once, whichever of the failure path and `finally` gets there first.
  let stagesClosed: Promise<unknown> | null = null;
  const closeStages = (): Promise<unknown> => (stagesClosed ??= Promise.allSettled(stages.map((stage) => stage.close())));
  const capacity = Math.floor(DEFAULT_BUFFER_LIMIT / frameBytes);

  let run: PipelineRun;
  try {
    await openStages(job, zeros, stages);
    run = await runPipeline(job, { reader, writer, sink }, stages, capacity);
  } catch (error) {
    // abort() kills the worker's ffmpeg and waits for it to release the output
    // file, so the partial file can be deleted here and a failed job never
    // leaves a misleading one behind. The stages close at the same time, not
    // after it: each is bounded by ABORT_TIMEOUT_MS on its own (worker-abort.ts).
    try { decoder.kill(); } catch {}
    await Promise.allSettled([sink.abort(), closeStages(), decoder.exited, decodeErrDrained]);
    removePartialOutput(output, sink.framesWritten, outputExisted);
    throw error;
  } finally {
    sink.close();
    await closeStages();
  }

  const decodeExit = await decoder.exited;
  await decodeErrDrained;
  if (decodeExit !== 0) throw new Error(ffmpegFailedMessage("decode", decodeExit, decodeErrText));

  return finishFrameGen(job, writer, stages, run, started);
}

/** Probes the tools, the DLSSG runtime and the source, and plans the interpolation. */
async function planFrameGen(options: FrameGenOptions): Promise<FrameGenJob> {
  const progress = options.onProgress ?? (() => {});
  // Before the host probe, which starts a GPU process of up to PROBE_TIMEOUT_MS, and again after it: the probe does not watch the signal.
  throwIfAborted(options.signal);
  const { ffmpeg, ffprobe } = requireFfmpegTools("frame generation");

  const caps = await probeDlssg(options.runtimeDir);
  throwIfAborted(options.signal);
  if (!caps.available) throw new Error(`DLSS Frame Generation is not available: ${caps.detail}`);
  const nativeMultiplierMax = caps.multiFrameCountMax + 1;

  const info = probeVideo(ffprobe, options.input, ffmpeg);
  // Every encoder here writes 4:2:0, which cannot represent an odd dimension,
  // so the whole chain runs at even sizes and the decoder scales to match --
  // the same rule video.ts and image.ts apply to their targets.
  const width = evenSize(info.width);
  const height = evenSize(info.height);
  const rescaled = width !== info.width || height !== info.height;
  const frameBytes = width * height * 4;
  if (info.frames === null || info.frames <= 0)
    throw new Error("Could not determine the source frame count, which frame generation needs for its progress estimate. Re-mux the file (e.g. `ffmpeg -i in -c copy out.mp4`) so ffprobe can read it.");
  const frames = info.frames;
  // The nominal CFR clock, not the measured average: planning needs exact ratios (30 -> 60 must be 2x).
  const sourceRate = parseRational(info.nominalFpsText);
  const multiplier = options.multiplier ?? DEFAULT_FRAME_GEN_MULTIPLIER;
  const targetRate = options.targetFps !== undefined ? resolveTargetRate(options.targetFps) : ratMul(sourceRate, rational(multiplier));
  const plan = chooseInterpolationPlan(sourceRate, targetRate, options.engine ?? "auto", nativeMultiplierMax, { cfr: true, hagsEnabled: caps.hagsEnabled });
  // Estimates for the progress report only; the exact output length is set
  // from the decoded count by writer.endAt() at end of stream. `frames` is
  // nb_frames (or duration x avg_frame_rate), counted in the MEASURED clock, so
  // it pairs with info.fps — the same measured rate — to give seconds, never
  // with sourceRate (r_frame_rate, the clock the decoder resamples to).
  const sourceSeconds = frames / info.fps;
  const expectedDecoded = Math.max(1, Math.round(sourceSeconds * ratToNumber(sourceRate)));
  const estimatedOutput = Math.ceil(sourceSeconds * ratToNumber(targetRate));
  const expectsGeneration = plan.generatedPerInterval > 0;
  const output = options.output ?? defaultOutputPath(options.input, "dlssg", `.${FRAME_GEN_CONTAINER}`);
  // Read before anything can write there: it decides what the failure path may delete.
  const outputExisted = existsSync(output);
  const detail =
    plan.path === "Native DLSSG"
      ? `native ${plan.nativeMultiplier}x, ${plan.generatedPerInterval} generated per interval`
      : plan.path === "Cascade"
        ? `${plan.cascadeStages} x 2x stage(s) on a ${plan.gridMultiplier}x grid, max timing error ${ratToNumber(plan.maximumTemporalError).toFixed(4)} s`
        : "no synthesis, nearest source frame";
  progress(0, `source ${info.width}x${info.height}${rescaled ? ` -> ${width}x${height} (4:2:0 needs even dimensions)` : ""}${info.displayAspect ? ` (non-square pixels, display ${info.displayAspect.num}:${info.displayAspect.den})` : ""} ${info.codec} ${formatRate(sourceRate)} fps, ${frames} frames${expectedDecoded !== frames ? ` (~${expectedDecoded} after the ${formatRate(sourceRate)} CFR decode)` : ""}; ${plan.path}: -> ${formatRate(targetRate)} fps (${detail}); HAGS ${caps.hagsEnabled ? "on" : "off"}; ~${estimatedOutput} output frames`);
  return { options, progress, ffmpeg, ffprobe, caps, info, width, height, frameBytes, sourceRate, targetRate, plan, expectedDecoded, expectsGeneration, output, outputExisted };
}

/** Starts the decoder and opens the encode sink, which owns the audio and the output file. */
async function openEncodePipeline({ options, progress, ffmpeg, info, width, height, targetRate, output }: FrameGenJob) {
  const decoder = Bun.spawn([ffmpeg, ...decodeArgv({ input: options.input, source: info, output: { width, height } })], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  // Only re-open the source as a second input when it actually has audio to carry;
  // otherwise ffmpeg needlessly demuxes/decodes the whole source again.
  const wantAudio = info.hasAudio;
  // Probed on the device the encode will use, FRAMEGEN_CUDA_DEVICE (framegen-plan.ts says why).
  const resolvedCodec = resolveEncodeCodec(options.codec ?? DEFAULT_ENCODE_SETTINGS.codec, ffmpeg, FRAMEGEN_CUDA_DEVICE);
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
        // The even-dimension rescale above changes the pixel grid, so the source's
        // DAR -- not its sample aspect -- is what the output must be tagged with.
        displayAspect: info.displayAspect,
        codec: resolvedCodec.codec,
        quality: options.quality ?? DEFAULT_ENCODE_SETTINGS.quality,
        hasAudio: wantAudio,
      }),
    );
  } catch (error) {
    try { decoder.kill(); } catch {}
    await Promise.allSettled([decoder.exited]);
    throw error;
  }
  if (sink.note) progress(0, sink.note);
  return { decoder, sink };
}

/** Opens every stage into `stages`, which the caller closes whatever happens here. */
async function openStages({ options, progress, width, height, plan }: FrameGenJob, zeros: Uint16Array, stages: Stage[]): Promise<void> {
  const generatedCounts: number[] = [];
  if (plan.path === "Native DLSSG") generatedCounts.push(plan.generatedPerInterval);
  else if (plan.path === "Cascade") for (let stage = 0; stage < plan.cascadeStages; stage++) generatedCounts.push(1);
  // Open every stage's host process and guide thread concurrently: each
  // brings up its own D3D12/NGX or CUDA/NVOFA context, ~1 s of fixed cost
  // that would otherwise be paid stage by stage.
  const openStage = async (index: number, generatedCount: number): Promise<Stage> => {
    // Only the last stage — 2^(stages-1) evaluations per source frame, the
    // bottleneck — gets a packer thread; the others pack inline so the machine
    // is not oversubscribed.
    const packInline = index !== generatedCounts.length - 1;
    const results = await Promise.allSettled([
      DlssgSession.open(options.runtimeDir, { width, height, generatedCount, sharedFrames: true }),
      openGuideWorker({ type: "open", width, height, detectSourceCuts: index === 0, packInline }),
      packInline ? Promise.resolve(null) : openGuideWorker({ type: "open-packer", width, height }),
    ]);
    const [sessionResult, guideResult, packerResult] = results;
    if (sessionResult.status === "rejected" || guideResult.status === "rejected" || packerResult.status === "rejected") {
      // Release whatever came up so a partial failure leaks nothing.
      if (sessionResult.status === "fulfilled") await sessionResult.value.close(ABORT_TIMEOUT_MS);
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
}

/** The frame loop: feeds the stages, writes the encode and finishes the sink, failing fast when generation is disabled. */
async function runPipeline(
  { options, progress, frameBytes, sourceRate, plan, caps, expectedDecoded, expectsGeneration }: FrameGenJob,
  { reader, writer, sink }: { reader: FrameReader; writer: NearestTimestampWriter; sink: EncodeSink },
  stages: Stage[],
  capacity: number,
): Promise<PipelineRun> {
  const noneGenerated = () => stages.every((stage) => stage.generatedTotal === 0);
  const check = (): void => {
    // Fail fast before spending the whole encode: nothing synthesised after
    // several real intervals means the runtime has disabled generation.
    if (expectsGeneration && stages[0]!.intervals >= FG_PROBE_INTERVALS && noneGenerated()) throw new FrameGenDisabledError(noFramesGeneratedMessage(plan, { disabledFrames: stages[0]!.session.disabledFrames, hagsEnabled: caps.hagsEnabled }), plan);
  };
  const params: RunParams = {
    reader,
    frameBytes,
    sourceRate,
    stages,
    writer,
    capacity,
    // expectedDecoded, not nb_frames: the decode is CFR-resampled, so the container count can be short and the bar would pass 100 %.
    onProcessed: (count) => {
      const { fraction, message, frames } = estimatedFrameProgress(count, expectedDecoded);
      progress(fraction, message, frames);
    },
    check,
    signal: options.signal,
  };
  const maxGenerated = Math.max(0, ...stages.map((s) => s.generatedCount));
  // Even one input/output transaction may exceed the credit window for enormous frames.
  const sequential = process.env.NR_FRAMEGEN_SEQUENTIAL === "1" || capacity < maxGenerated + 3;
  const mode: FrameGenResult["mode"] = sequential ? "sequential" : "overlapped";
  if (sequential) progress(0, `pipeline: sequential (${capacity} frame credits)`);
  const runStarted = performance.now();
  const run = sequential ? await runSequential(params) : await runOverlapped(params);
  const inputFrames = run.decoded;
  const peak = run.peak;
  if (run.busy) {
    // Busy seconds per owner over the run's wall time: the owner closest to the
    // wall time is the bottleneck.
    const wall = (performance.now() - runStarted) / 1000;
    const parts = Object.entries(run.busy).sort(([a], [b]) => a.localeCompare(b)).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}`);
    progress(0.97, `pipeline busy (s) over ${wall.toFixed(1)} s wall: ${parts.join(", ")}`);
  }
  if (inputFrames === 0) throw new NoFramesDecodedError();
  // Clips shorter than the probe window still must not pass off a duplicate-frame resample as generation.
  if (expectsGeneration && stages[0]!.intervals >= 1 && noneGenerated()) throw new FrameGenDisabledError(noFramesGeneratedMessage(plan, { disabledFrames: stages[0]?.session.disabledFrames ?? 0, hagsEnabled: caps.hagsEnabled }), plan);
  // Not before the checks above: a FrameGenDisabledError from them makes an
  // "auto" job re-run as a cascade, which must still be cancellable.
  options.onFinishing?.();
  await sink.finish();
  return { mode, inputFrames, peak };
}

function finishFrameGen(
  { progress, ffprobe, width, height, sourceRate, targetRate, plan, caps, frameBytes, output }: FrameGenJob,
  writer: NearestTimestampWriter,
  stages: Stage[],
  { mode, inputFrames, peak }: PipelineRun,
  started: number,
): FrameGenResult {
  progress(0.98, "verifying output");
  // writer.outputCount: fixed by endAt() from the decoded count, so it is the
  // length that was actually written, whatever the container declared.
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
    // null when the sequential runner ran: it keeps no credit ledger, so there
    // is no high-water mark to report.
    peakBufferBytes: peak === null ? null : peak * frameBytes,
    ms: Math.round(performance.now() - started),
  };
}
