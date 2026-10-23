/**
 * Video job: ffmpeg decodes to raw RGBA frames on a pipe, every frame goes
 * through the job's engine chain (Super Resolution, then Neural Rendering), and
 * the result is encoded with the original audio copied across. Owns the choice
 * between the three encode paths (GPU-resident async, threaded NVENC,
 * single-thread rawvideo) and the GPU session's lifetime.
 * ffmpeg / ffprobe are external tools found via tools.ts.
 */
import { existsSync } from "node:fs";
import type { EncodeSettings, JobRequest, NeuralRenderingStep, ScaleSettings, StepKind, SuperResolutionStep } from "../server/api-types.ts";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_SCALE_SETTINGS, jobSteps, stepsSuffix } from "../server/api-types.ts";
import { evenSize, nvencLimitExceeded, resolveTargetSize, srOutputProblem } from "../server/output-size.ts";
import { throwIfAborted, throwIfAbortedAfterYield } from "./cancel.ts";
import { createEngineChain, type Engine } from "./engine.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { aspectArgs, audioArgs, decodeArgv, encoderArgs, faststartArgs, muxCopyArgs } from "./ffmpeg-args.ts";
import { ffmpegFailedMessage, NoFramesDecodedError } from "./ffmpeg-failure.ts";
import type { FrameCounts } from "./frame-flow.ts";
import { frameProgress, type ProgressReporter } from "./frame-progress.ts";
import { defaultOutputPath, inputAsOutputProblem } from "./output-path.ts";
import { framesWrittenOf, removePartialOutput } from "./partial-output.ts";
import { tryParseRate } from "./rational.ts";
import { createFrameGuide, type FrameGuide } from "./frame-guide.ts";
import { SceneCutDetector } from "./scene-score.ts";
import { FrameReader } from "./frame-reader.ts";
import { probeNvencCaps, type NvencSdkCodec } from "./nvenc.ts";
import { runThreadedEncode } from "./threaded-encode.ts";
import { runAsyncNrEncode } from "./async-nr-encode.ts";
import { DXGI_FORMAT_R8G8B8A8_UNORM, linearLayout } from "../native/d3d12.ts";
import { describeGpu, openGpu, type GpuSession } from "./gpu.ts";
import { requireFfmpegTools } from "./tools.ts";
import { probeVideo, type VideoInfo } from "./video-probe.ts";

export interface VideoJobOptions {
  input: string;
  output?: string;
  superResolution?: SuperResolutionStep;
  neuralRendering?: NeuralRenderingStep;
  /** A lanczos resize of the decoded frames; only without superResolution, which sets the size itself. */
  resize?: ScaleSettings;
  encode?: EncodeSettings;
  /** One of the two, never both: see GpuOptions. */
  adapterIndex?: number;
  adapterUuid?: string;
  debugLayer?: boolean;
  runtimeDir?: string;
  appDataPath?: string;
  onProgress?: ProgressReporter;
  /** Cooperative cancellation (see cancel.ts): checked at every frame until the encode is finishing, which then completes. */
  signal?: AbortSignal;
  /**
   * Called once when the run passes the point where a cancel can stop it: every
   * frame is encoded and only finalising the output is left, which completes
   * or fails. The job manager stops waiting on a cancel then.
   */
  onFinishing?: () => void;
}

/** What a run adds to a request: its folders, and how it reports and stops. */
type VideoRun = Pick<VideoJobOptions, "runtimeDir" | "appDataPath" | "onProgress" | "signal" | "onFinishing">;

/**
 * The options a validated video request runs with. Whatever runs a JobRequest maps it through here, so no
 * front end reads a request differently from the job worker.
 */
export function videoJobOptions(request: JobRequest, run: VideoRun): VideoJobOptions {
  return {
    input: request.input,
    output: request.output,
    superResolution: request.superResolution,
    neuralRendering: request.neuralRendering,
    resize: request.resize,
    encode: request.encode,
    adapterUuid: request.adapterUuid,
    ...run,
  };
}

export interface VideoJobResult {
  output: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  sceneCuts: number;
  /** The steps that ran, in order. */
  steps: StepKind[];
  ms: number;
}

/**
 * Whether frames can be encoded in-process on the GPU (nvenc.ts) so ffmpeg only
 * muxes the compressed elementary stream, instead of an uncompressed rawvideo
 * pipe plus swscale. Null means take the rawvideo path.
 *
 * The gates are NVENC's own limits: 4:2:0 needs even dimensions, and the
 * encoder caps the frame size per codec (NVENC_MAX_SIDE, measured). av1_nvenc
 * falls through to null: nvenc.ts's CODEC_GUID only carries the H.264 and HEVC
 * GUIDs, so there is no in-process AV1 encoder.
 */
export function nvencNativeTarget(codec: EncodeSettings["codec"], width: number, height: number): { codec: NvencSdkCodec; demux: string } | null {
  if (width % 2 !== 0 || height % 2 !== 0) return null;
  if (nvencLimitExceeded(codec, { width, height }) !== null) return null;
  if (codec === "h264_nvenc") return { codec: "h264", demux: "h264" };
  if (codec === "hevc_nvenc") return { codec: "hevc", demux: "hevc" };
  return null;
}

/** Integer num/den of an ffmpeg rate string ("30000/1001", "25") that videoInfoFrom has already proven usable, for NVENC's rate fields. */
function rateParts(text: string): { num: number; den: number } {
  const rate = tryParseRate(text);
  if (!rate) throw new Error(`No usable frame rate in ${JSON.stringify(text)}.`);
  return { num: Number(rate.num), den: Number(rate.den) };
}

/** What every encode path of a job shares, settled once before a path is chosen. */
interface VideoJob {
  options: VideoJobOptions;
  progress: NonNullable<VideoJobOptions["onProgress"]>;
  ffmpeg: string;
  info: VideoInfo;
  /** The size the output is written at: the scale setting applied, then rounded to even. */
  target: { width: number; height: number };
  output: string;
  /** Whether the destination existed before the job: see partial-output.ts. */
  outputExisted: boolean;
  upscaling: boolean;
  renderWidth: number;
  renderHeight: number;
  session: GpuSession;
  cudaOrdinal: number;
  /** The encode settings with the codec resolved on this GPU. */
  encode: EncodeSettings;
  completed: (size: { width: number; height: number }, counts: FrameCounts) => VideoJobResult;
}

/** An open engine and what the two engine-driven encode paths feed it. */
interface EnginePath {
  engine: Engine;
  outWidth: number;
  outHeight: number;
  /** Decode argv without the binary; both encode paths spawn it themselves. */
  decodeArgs: ReturnType<typeof decodeArgv>;
  /** Whether the source is opened as a second input so its audio is copied. */
  wantAudio: boolean;
  frameBytes: number;
  guide: (rgba: Uint8Array, index: number) => { reset: boolean; motion: Float32Array | null; sceneCut: boolean };
}

async function prepareVideoJob(options: VideoJobOptions): Promise<VideoJob> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  const { ffmpeg, ffprobe } = requireFfmpegTools("video jobs");
  const requestedEncode = options.encode ?? DEFAULT_ENCODE_SETTINGS;
  const info = probeVideo(ffprobe, options.input, ffmpeg);
  const sr = options.superResolution;
  // Every codec here encodes 4:2:0 (yuv420p / NVENC NV12), which requires even
  // width and height. resolveTargetSize leaves scale 'none' (the default) at the
  // raw source size, so an odd-sized source would only fail at encode time.
  const rawTarget = resolveTargetSize(info.width, info.height, sr?.scale ?? options.resize ?? DEFAULT_SCALE_SETTINGS);
  const target = { width: evenSize(rawTarget.width), height: evenSize(rawTarget.height) };
  // SR's limits need the source size, so they are checked here, before the GPU opens and the job says it is upscaling.
  const srProblem = sr ? srOutputProblem(info, target) : null;
  if (srProblem) throw new Error(srProblem);
  const steps = jobSteps({ superResolution: sr, neuralRendering: options.neuralRendering });
  const resized = !sr && options.resize !== undefined && options.resize.mode !== "none";
  const output = options.output ?? defaultOutputPath(options.input, stepsSuffix(steps, resized), `.${requestedEncode.container}`);
  const inputProblem = inputAsOutputProblem(options.input, output);
  if (inputProblem) throw new Error(inputProblem);
  // Whether the destination is ours to delete after an abnormal end: see partial-output.ts.
  const outputExisted = existsSync(output);
  // SR upscales inside DLSS: decode at source size and let the engine write the
  // target size. Without SR, ffmpeg decodes frames at the target size.
  const upscaling = sr !== undefined;
  const renderWidth = upscaling ? info.width : target.width;
  const renderHeight = upscaling ? info.height : target.height;
  progress(0, `source ${info.width}x${info.height}${info.displayAspect ? ` (non-square pixels, display ${info.displayAspect.num}:${info.displayAspect.den})` : ""} ${info.codec} ${info.fpsText} fps, ${info.frames ?? "?"} frames; ${upscaling ? `upscaling to ${target.width}x${target.height}` : `working size ${target.width}x${target.height}`}`);

  /** Says so in the progress line and builds the job's result, once an encode of `counts` frames at `size` has finished. */
  const completed = (size: { width: number; height: number }, counts: FrameCounts): VideoJobResult => {
    if (counts.frames === 0) throw new NoFramesDecodedError();
    progress(1, `encoded ${counts.frames} frames to ${output}${counts.sceneCuts ? ` (${counts.sceneCuts} scene cuts reset history)` : ""}`);
    return { output, width: size.width, height: size.height, fps: info.fps, frames: counts.frames, sceneCuts: counts.sceneCuts, steps, ms: Math.round(performance.now() - started) };
  };

  // The probe above is synchronous; a cancel sent during it is only delivered after a yield.
  await throwIfAbortedAfterYield(options.signal);
  const session = openGpu({ adapterIndex: options.adapterIndex, adapterUuid: options.adapterUuid, debugLayer: options.debugLayer });
  progress(0, describeGpu(session));
  // session.cudaOrdinal, not adapterIndex: see GpuSession.cudaOrdinal. Every
  // CUDA user below (ffmpeg's -gpu, in-process NVENC, NVOFA) takes this one.
  const cudaOrdinal = session.cudaOrdinal;
  // Resolve the codec on that device before choosing a path: an NVENC request
  // that cannot run there degrades to its CPU sibling, and every path below
  // branches on the result.
  const resolvedCodec = resolveEncodeCodec(requestedEncode.codec, ffmpeg, cudaOrdinal, target);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);
  const encode: EncodeSettings = { ...requestedEncode, codec: resolvedCodec.codec };
  return { options, progress, ffmpeg, info, target, output, outputExisted, upscaling, renderWidth, renderHeight, session, cudaOrdinal, encode, completed };
}

/** The GPU-resident async path for Neural Rendering alone (see processVideo), which closes the GPU session when it ends. */
async function runGpuResidentNr(
  { options, progress, ffmpeg, info, output, outputExisted, target, session, cudaOrdinal, encode, completed }: VideoJob,
  nrNative: { codec: NvencSdkCodec; demux: string },
  nrStep: NeuralRenderingStep,
): Promise<VideoJobResult> {
  try {
    const { num, den } = rateParts(info.fpsText);
    const layout = linearLayout(target.width, target.height, DXGI_FORMAT_R8G8B8A8_UNORM);
    const decodeArgs = decodeArgv({ input: options.input, source: info, output: target, frameRate: info.fpsText });
    const wantAudio = info.hasAudio && encode.copyAudio;
    const sinkArgs = muxCopyArgs({
      demux: nrNative.demux, frameRate: info.fpsText, audioSource: wantAudio ? options.input : null,
      container: encode.container, displayAspect: info.displayAspect, size: target, output,
    });
    const cuts = new SceneCutDetector(target.width, target.height);
    const guide = (rgba: Uint8Array, index: number) => cuts.guide(rgba, index);
    progress(0, `encode: NVENC ${nrNative.codec} (GPU-resident async zero-copy pipeline)`);
    const { DlssNrSession } = await import("../ngx/nr-render.ts");
    const nr = DlssNrSession.open(session, { width: target.width, height: target.height, settings: nrStep.settings, runtimeDir: options.runtimeDir!, dllDir: nrStep.dllDir, appDataPath: options.appDataPath });
    try {
      const r = await runAsyncNrEncode({
        session, nr, ffmpeg, decodeArgs, sinkArgs,
        width: target.width, height: target.height, rowPitch: layout.rowPitch, totalBytes: layout.totalBytes,
        enc: { fpsNum: num, fpsDen: den, codec: nrNative.codec, cq: encode.quality, ordinal: cudaOrdinal },
        totalFrames: info.frames, guide, onProgress: progress, signal: options.signal, onFinishing: options.onFinishing,
      });
      return completed(target, r);
    } catch (error) {
      // The orchestrator has already made the mux ffmpeg release the file.
      removePartialOutput(output, framesWrittenOf(error), outputExisted);
      throw error;
    } finally {
      nr.close();
    }
  } finally {
    session.close();
  }
}

function openEngineChain({ options, session, renderWidth, renderHeight, target }: VideoJob): Engine {
  const sr = options.superResolution;
  const nr = options.neuralRendering;
  try {
    return createEngineChain(session, {
      width: renderWidth,
      height: renderHeight,
      sr: sr ? { outputWidth: target.width, outputHeight: target.height, dllDir: sr.dllDir } : undefined,
      nr: nr ? { settings: nr.settings, dllDir: nr.dllDir } : undefined,
      runtimeDir: options.runtimeDir,
      appDataPath: options.appDataPath,
    });
  } catch (error) {
    session.close(); // setup failed before the main try/finally owns it, so close here or leak the GPU session
    throw error;
  }
}

/** Decode, DLSS and NVENC each on their own thread, with ffmpeg only muxing the elementary stream. */
async function runThreadedNvenc(
  { options, progress, ffmpeg, info, output, cudaOrdinal, encode }: VideoJob,
  { engine, outWidth, outHeight, decodeArgs, wantAudio, frameBytes, guide }: EnginePath,
  nativeTarget: { codec: NvencSdkCodec; demux: string },
  counts: FrameCounts,
): Promise<void> {
  const { num, den } = rateParts(info.fpsText);
  const sinkArgs = muxCopyArgs({
    demux: nativeTarget.demux, frameRate: info.fpsText, audioSource: wantAudio ? options.input : null,
    container: encode.container, displayAspect: info.displayAspect, size: { width: outWidth, height: outHeight }, output,
  });
  progress(0, `encode: NVENC ${nativeTarget.codec} (threaded GPU pipeline, mux-only)`);
  const result = await runThreadedEncode({
    engine, ffmpeg, decodeArgs, frameBytes, sinkArgs,
    enc: { width: outWidth, height: outHeight, fpsNum: num, fpsDen: den, codec: nativeTarget.codec, cq: encode.quality, ordinal: cudaOrdinal },
    totalFrames: info.frames, guide, onProgress: progress, signal: options.signal, onFinishing: options.onFinishing,
  });
  counts.frames = result.frames;
  counts.sceneCuts = result.sceneCuts;
}

/**
 * How long an encoder whose pipe broke gets to exit on its own before it is killed. A chosen margin: ffmpeg
 * prints why it stopped and exits at once (one whose encoder would not open exited with code 8 just after the
 * write failed), so this only bounds an encoder that closed its input and kept running.
 */
const ENCODER_QUIT_WAIT_MS = 5000;

/** Raw RGBA frames out to ffmpeg, which does the encode; the fallback for everything the NVENC paths cannot take. */
async function runRawvideo(
  { options, progress, ffmpeg, info, output, cudaOrdinal, encode }: VideoJob,
  { engine, outWidth, outHeight, decodeArgs, wantAudio, frameBytes, guide }: EnginePath,
  counts: FrameCounts,
): Promise<void> {
  // Fallback: raw RGBA out to ffmpeg, which does the encode.
  const encoderArgv = encoderArgs(encode, cudaOrdinal);
  progress(0, `encode: ${encoderArgv[encoderArgv.indexOf("-c:v") + 1]} via ffmpeg (single-thread rawvideo pipeline)`);
  const decoder = Bun.spawn([ffmpeg, ...decodeArgs], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  // No -shortest: it trims whichever stream runs longer, and when a source's audio ends before its video (a
  // 30 s stream-copied cut of 2.mp4 ends its audio 23 ms early) that drops video frames the job counted as
  // written. Every frame written is a source frame, so the output keeps the source's stream lengths, as the
  // NVENC paths' muxCopyArgs does.
  const encoder = Bun.spawn(
    [
      ffmpeg, "-v", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${outWidth}x${outHeight}`, "-r", info.fpsText, "-i", "pipe:0",
      ...(wantAudio ? ["-i", options.input] : []),
      "-map", "0:v:0", ...audioArgs(wantAudio, encode.container), ...encoderArgv, ...aspectArgs(info.displayAspect, { width: outWidth, height: outHeight }), ...faststartArgs(encode.container),
      output,
    ],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  const reader = new FrameReader(decoder.stdout);
  try {
    // Kept one frame ahead: the decode of frame n+1 overlaps the GPU pass on n.
    let pending = reader.next(frameBytes);
    for (;;) {
      throwIfAborted(options.signal);
      const rgba = await pending;
      if (!rgba) break;
      pending = reader.next(frameBytes);
      const g = guide(rgba, counts.frames);
      if (g.sceneCut) counts.sceneCuts++;
      const result = engine.process({ rgba, reset: g.reset, motion: g.motion });
      const wrote = encoder.stdin.write(result);
      if (wrote instanceof Promise) await wrote;
      counts.frames++;
      const { fraction, message, frames } = frameProgress(counts.frames, info.frames);
      progress(fraction, message, frames);
    }
    options.onFinishing?.();
    encoder.stdin.end();
  } catch (error) {
    // Both children are ours: kill them and wait, so the encoder has released
    // the output file by the time runEngineJob's catch deletes it. A frame
    // written after the encoder has quit fails as a bare EPIPE, which says
    // nothing of why; the encoder is then left to finish quitting, and its own
    // exit code and message are what the job reports.
    try { decoder.kill(); } catch {}
    const encoderQuit = (error as { code?: unknown }).code === "EPIPE" ? await Promise.race([encoder.exited, Bun.sleep(ENCODER_QUIT_WAIT_MS).then(() => null)]) : null;
    if (encoderQuit === null) try { encoder.kill(); } catch {}
    await Promise.allSettled([decoder.exited, encoder.exited]);
    if (encoderQuit !== null && encoderQuit !== 0) throw new Error(ffmpegFailedMessage("encode", encoderQuit, await new Response(encoder.stderr).text()));
    throw error;
  }
  const [decodeExit, encodeExit] = await Promise.all([decoder.exited, encoder.exited]);
  const decodeErr = (await new Response(decoder.stderr).text()).trim();
  const encodeErr = (await new Response(encoder.stderr).text()).trim();
  if (decodeExit !== 0) throw new Error(ffmpegFailedMessage("decode", decodeExit, decodeErr));
  if (encodeExit !== 0) throw new Error(ffmpegFailedMessage("encode", encodeExit, encodeErr));
}

async function runEngineJob(job: VideoJob): Promise<VideoJobResult> {
  const { options, progress, info, output, outputExisted, session, cudaOrdinal, encode, renderWidth, renderHeight, completed } = job;
  const engine = openEngineChain(job);
  const outWidth = engine.outputWidth;
  const outHeight = engine.outputHeight;

  // Decode argv without the binary; both encode paths below spawn it themselves.
  const decodeArgs = decodeArgv({ input: options.input, source: info, output: { width: renderWidth, height: renderHeight }, frameRate: info.fpsText });

  // Only open the source as a second input when its audio is actually copied:
  // otherwise the encoder demuxes and decodes the whole source a second time,
  // which cost more per frame than the raw video pipe it was competing with.
  // Video is always input 0 (the pipe); audio, when copied, is input 1 (source).
  const wantAudio = info.hasAudio && encode.copyAudio;

  let frameGuide: FrameGuide;
  try {
    frameGuide = createFrameGuide(renderWidth, renderHeight, { flow: options.superResolution?.motion === "flow", cudaOrdinal, progress });
  } catch (error) {
    // Nothing below owns the engine or the session yet.
    engine.close();
    session.close();
    throw error;
  }
  const guide = frameGuide.guide;

  const frameBytes = renderWidth * renderHeight * 4;
  // Second choice: decode, DLSS and NVENC each on their own thread, encoding on
  // the GPU here (nvenc.ts) so ffmpeg only muxes the elementary stream
  // (-c:v copy). CPU/AV1 codecs, oversized frames, or an NVENC that will not
  // come up here fall through to the single-thread rawvideo path.
  const nativeTarget = nvencNativeTarget(encode.codec, outWidth, outHeight);
  const nvenc = nativeTarget !== null ? probeNvencCaps(cudaOrdinal) : null;
  if (nvenc && !nvenc.available) progress(0, `encode: NVENC direct path unavailable (${nvenc.detail}); falling back to the single-thread rawvideo pipeline`);
  const useThreaded = nvenc?.available === true;

  const path: EnginePath = { engine, outWidth, outHeight, decodeArgs, wantAudio, frameBytes, guide };
  const counts: FrameCounts = { frames: 0, sceneCuts: 0 };
  try {
    if (useThreaded && nativeTarget) await runThreadedNvenc(job, path, nativeTarget, counts);
    else await runRawvideo(job, path, counts);
  } catch (error) {
    // The threaded orchestrator reports its count on the error; the rawvideo loop counted here.
    removePartialOutput(output, useThreaded ? framesWrittenOf(error) : counts.frames, outputExisted);
    throw error;
  } finally {
    frameGuide.close();
    engine.close();
    session.close();
  }
  return completed({ width: outWidth, height: outHeight }, counts);
}

export async function processVideo(options: VideoJobOptions): Promise<VideoJobResult> {
  const job = await prepareVideoJob(options);
  const { target, encode, cudaOrdinal, upscaling } = job;

  // Fastest path, tried first: DLSS output stays on the GPU and NVENC reads it
  // through a shared buffer, so the two overlap with no CPU frame copy between
  // them, which the threaded pipeline cannot avoid. Only Neural Rendering alone
  // qualifies (no SR to upscale first) with an NVENC codec at even, in-cap
  // dimensions; feature 18 consumes no motion vectors, so it needs no optical flow.
  const nr = options.neuralRendering;
  const nrNative = nr && !upscaling && options.runtimeDir ? nvencNativeTarget(encode.codec, target.width, target.height) : null;
  if (nr && nrNative && probeNvencCaps(cudaOrdinal).available) return runGpuResidentNr(job, nrNative, nr);
  return runEngineJob(job);
}
