/**
 * Video job: ffmpeg decodes to raw RGBA frames on a pipe, every frame goes
 * through the engine, and the result is encoded with the original audio copied
 * across. Owns the choice between the three encode paths (GPU-resident async,
 * threaded NVENC, single-thread rawvideo) and the GPU session's lifetime.
 * ffmpeg / ffprobe are external tools found via tools.ts.
 */
import { existsSync } from "node:fs";
import type { EncodeSettings, EngineKind, MotionKind, NrSettings, ScaleSettings } from "../server/api-types.ts";
import { DEFAULT_ENCODE_SETTINGS } from "../server/api-types.ts";
import { throwIfAborted, throwIfAbortedAfterYield } from "./cancel.ts";
import { createEngine, type Engine } from "./engine.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { aspectArgs, audioArgs, decodeArgv, encoderArgs, faststartArgs, muxCopyArgs } from "./ffmpeg-args.ts";
import { ffmpegFailedMessage, NoFramesDecodedError } from "./ffmpeg-failure.ts";
import type { FrameCounts } from "./frame-flow.ts";
import { frameProgress, type ProgressReporter } from "./frame-progress.ts";
import { defaultOutputPath } from "./output-path.ts";
import { framesWrittenOf, removePartialOutput } from "./partial-output.ts";
import { tryParseRate } from "./rational.ts";
import { createMotionEstimator } from "./flow.ts";
import { SceneCutDetector } from "./scene-score.ts";
import { FrameReader } from "./frame-reader.ts";
import { probeNvencCaps, type NvencSdkCodec } from "./nvenc.ts";
import { runThreadedEncode } from "./threaded-encode.ts";
import { runAsyncNrEncode } from "./async-nr-encode.ts";
import { tryCreateNvofBackend } from "./nvof.ts";
import { DXGI_FORMAT_R8G8B8A8_UNORM, linearLayout } from "../native/d3d12.ts";
import { describeGpu, openGpu, type GpuSession } from "./gpu.ts";
import { resolveTargetSize } from "./image.ts";
import { evenSize } from "./resize.ts";
import { requireFfmpegTools } from "./tools.ts";
import { probeVideo, type VideoInfo } from "./video-probe.ts";

export interface VideoJobOptions {
  input: string;
  output?: string;
  engine: EngineKind;
  motion: MotionKind;
  scale: ScaleSettings;
  settings: NrSettings;
  encode?: EncodeSettings;
  /** One of the two, never both: see GpuOptions. */
  adapterIndex?: number;
  adapterUuid?: string;
  debugLayer?: boolean;
  runtimeDir?: string;
  /** Specific DLSS DLL folder to load (version switching); defaults to the runtime feature folder. */
  dllDir?: string;
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

export interface VideoJobResult {
  output: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  sceneCuts: number;
  engine: EngineKind;
  ms: number;
}

/**
 * Whether frames can be encoded in-process on the GPU (nvenc.ts) so ffmpeg only
 * muxes the compressed elementary stream, instead of an uncompressed rawvideo
 * pipe plus swscale. Null means take the rawvideo path.
 *
 * The gates are NVENC's own limits: 4:2:0 needs even dimensions, and the
 * hardware caps the frame size per codec — H.264 at 4096 and HEVC at 8192 on
 * current GPUs. av1_nvenc falls through to null: nvenc.ts's CODEC_GUID only
 * carries the H.264 and HEVC GUIDs, so there is no in-process AV1 encoder.
 */
export function nvencNativeTarget(codec: EncodeSettings["codec"], width: number, height: number): { codec: NvencSdkCodec; demux: string } | null {
  if (width % 2 !== 0 || height % 2 !== 0) return null;
  if (codec === "h264_nvenc") return width <= 4096 && height <= 4096 ? { codec: "h264", demux: "h264" } : null;
  if (codec === "hevc_nvenc") return width <= 8192 && height <= 8192 ? { codec: "hevc", demux: "hevc" } : null;
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
  // Every codec here encodes 4:2:0 (yuv420p / NVENC NV12), which requires even
  // width and height. resolveTargetSize leaves scale 'none' (the default) at the
  // raw source size, so an odd-sized source would only fail at encode time.
  const rawTarget = resolveTargetSize(info.width, info.height, options.scale);
  const target = { width: evenSize(rawTarget.width), height: evenSize(rawTarget.height) };
  const output = options.output ?? defaultOutputPath(options.input, options.engine, `.${requestedEncode.container}`);
  // Whether the destination is ours to delete after an abnormal end: see partial-output.ts.
  const outputExisted = existsSync(output);
  // SR upscales inside DLSS: decode at source size and let the engine write the
  // target size. Other engines get frames pre-scaled to the target by ffmpeg.
  const upscaling = options.engine === "sr";
  const renderWidth = upscaling ? info.width : target.width;
  const renderHeight = upscaling ? info.height : target.height;
  progress(0, `source ${info.width}x${info.height}${info.displayAspect ? ` (non-square pixels, display ${info.displayAspect.num}:${info.displayAspect.den})` : ""} ${info.codec} ${info.fpsText} fps, ${info.frames ?? "?"} frames; ${upscaling ? `upscaling to ${target.width}x${target.height}` : `working size ${target.width}x${target.height}`}`);

  /** Says so in the progress line and builds the job's result, once an encode of `counts` frames at `size` has finished. */
  const completed = (size: { width: number; height: number }, counts: FrameCounts): VideoJobResult => {
    if (counts.frames === 0) throw new NoFramesDecodedError();
    progress(1, `encoded ${counts.frames} frames to ${output}${counts.sceneCuts ? ` (${counts.sceneCuts} scene cuts reset history)` : ""}`);
    return { output, width: size.width, height: size.height, fps: info.fps, frames: counts.frames, sceneCuts: counts.sceneCuts, engine: options.engine, ms: Math.round(performance.now() - started) };
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
  const resolvedCodec = resolveEncodeCodec(requestedEncode.codec, ffmpeg, cudaOrdinal);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);
  const encode: EncodeSettings = { ...requestedEncode, codec: resolvedCodec.codec };
  return { options, progress, ffmpeg, info, target, output, outputExisted, upscaling, renderWidth, renderHeight, session, cudaOrdinal, encode, completed };
}

/** The GPU-resident async path (see processVideo), which closes the GPU session when it ends. */
async function runGpuResidentNr(
  { options, progress, ffmpeg, info, output, outputExisted, target, session, cudaOrdinal, encode, completed }: VideoJob,
  nrNative: { codec: NvencSdkCodec; demux: string },
): Promise<VideoJobResult> {
  try {
    const { num, den } = rateParts(info.fpsText);
    const layout = linearLayout(target.width, target.height, DXGI_FORMAT_R8G8B8A8_UNORM);
    const decodeArgs = decodeArgv({ input: options.input, source: info, output: target });
    const wantAudio = info.hasAudio && encode.copyAudio;
    const sinkArgs = muxCopyArgs({
      demux: nrNative.demux, frameRate: info.fpsText, audioSource: wantAudio ? options.input : null,
      container: encode.container, displayAspect: info.displayAspect, size: target, output,
    });
    const cuts = new SceneCutDetector(target.width, target.height);
    const guide = (rgba: Uint8Array, index: number) => cuts.guide(rgba, index);
    progress(0, `encode: NVENC ${nrNative.codec} (GPU-resident async zero-copy pipeline)`);
    const { DlssNrSession } = await import("../ngx/nr-render.ts");
    const nr = DlssNrSession.open(session, { width: target.width, height: target.height, settings: options.settings, runtimeDir: options.runtimeDir!, dllDir: options.dllDir, appDataPath: options.appDataPath });
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

function openEngine({ options, session, upscaling, renderWidth, renderHeight, target }: VideoJob): Engine {
  try {
    return createEngine(options.engine, session, {
      width: renderWidth,
      height: renderHeight,
      outputWidth: upscaling ? target.width : undefined,
      outputHeight: upscaling ? target.height : undefined,
      settings: options.settings,
      runtimeDir: options.runtimeDir,
      dllDir: options.dllDir,
      appDataPath: options.appDataPath,
    });
  } catch (error) {
    session.close(); // setup failed before the main try/finally owns it, so close here or leak the GPU session
    throw error;
  }
}

/** The per-frame guide, and the motion estimator behind it when the job asked for flow. */
function createGuide(
  { options, progress, session, cudaOrdinal, renderWidth, renderHeight }: VideoJob,
  engine: Engine,
): { guide: EnginePath["guide"]; estimator: ReturnType<typeof createMotionEstimator> | null } {
  // Scene-cut / motion guide. Both backends keep a one-frame history, so `guide`
  // must be called exactly once per frame and in decode order.
  const cuts = new SceneCutDetector(renderWidth, renderHeight);
  let estimator: ReturnType<typeof createMotionEstimator> | null = null;
  if (options.motion === "flow") {
    try {
      const nvof = tryCreateNvofBackend(renderWidth, renderHeight, cudaOrdinal);
      estimator = createMotionEstimator(renderWidth, renderHeight, nvof.backend ? { backend: nvof.backend } : {});
      progress(0, nvof.backend ? "optical flow: NVIDIA hardware (NVOFA)" : `optical flow: CPU block matching. ${nvof.reason}`);
    } catch (error) {
      engine.close();
      session.close();
      throw error;
    }
  }
  const guide = (rgba: Uint8Array, index: number): { reset: boolean; motion: Float32Array | null; sceneCut: boolean } => {
    if (estimator) {
      const g = estimator.process(rgba);
      return { reset: index === 0 || g.reset, motion: g.motion, sceneCut: g.reset && index > 0 };
    }
    return { ...cuts.guide(rgba, index), motion: null };
  };
  return { guide, estimator };
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

/** Raw RGBA frames out to ffmpeg, which does the encode; the fallback for everything the NVENC paths cannot take. */
async function runRawvideo(
  { options, progress, ffmpeg, info, output, cudaOrdinal, encode }: VideoJob,
  { engine, outWidth, outHeight, decodeArgs, wantAudio, frameBytes, guide }: EnginePath,
  counts: FrameCounts,
): Promise<void> {
  // Fallback: raw RGBA out to ffmpeg, which does the encode.
  const decoder = Bun.spawn([ffmpeg, ...decodeArgs], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const encoder = Bun.spawn(
    [
      ffmpeg, "-v", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${outWidth}x${outHeight}`, "-r", info.fpsText, "-i", "pipe:0",
      ...(wantAudio ? ["-i", options.input] : []),
      "-map", "0:v:0", ...audioArgs(wantAudio, encode.container), ...encoderArgs(encode, cudaOrdinal), ...aspectArgs(info.displayAspect, outWidth, outHeight, null), ...faststartArgs(encode.container),
      ...(wantAudio ? ["-shortest"] : []),
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
    // the output file by the time runEngineJob's catch deletes it.
    try { decoder.kill(); } catch {}
    try { encoder.kill(); } catch {}
    await Promise.allSettled([decoder.exited, encoder.exited]);
    throw error;
  }
  const [decodeExit, encodeExit] = await Promise.all([decoder.exited, encoder.exited]);
  const decodeErr = (await new Response(decoder.stderr).text()).trim();
  const encodeErr = (await new Response(encoder.stderr).text()).trim();
  if (decodeExit !== 0) throw new Error(ffmpegFailedMessage("decode", decodeExit, decodeErr));
  if (encodeExit !== 0) throw new Error(ffmpegFailedMessage("encode", encodeExit, encodeErr));
}

async function runEngineJob(job: VideoJob): Promise<VideoJobResult> {
  const { options, info, output, outputExisted, session, cudaOrdinal, encode, renderWidth, renderHeight, completed } = job;
  const engine = openEngine(job);
  const outWidth = engine.outputWidth;
  const outHeight = engine.outputHeight;

  // Decode argv without the binary; both encode paths below spawn it themselves.
  const decodeArgs = decodeArgv({ input: options.input, source: info, output: { width: renderWidth, height: renderHeight } });

  // Only open the source as a second input when its audio is actually copied:
  // otherwise the encoder demuxes and decodes the whole source a second time,
  // which cost more per frame than the raw video pipe it was competing with.
  // Video is always input 0 (the pipe); audio, when copied, is input 1 (source).
  const wantAudio = info.hasAudio && encode.copyAudio;

  const { guide, estimator } = createGuide(job, engine);

  const frameBytes = renderWidth * renderHeight * 4;
  // Second choice: decode, DLSS and NVENC each on their own thread, encoding on
  // the GPU here (nvenc.ts) so ffmpeg only muxes the elementary stream
  // (-c:v copy). The stages are ~4-5 ms each at 1080p and ran at their sum when
  // serial. CPU/AV1 codecs, oversized frames, or an NVENC that will not come up
  // here fall through to the single-thread rawvideo path.
  const nativeTarget = nvencNativeTarget(encode.codec, outWidth, outHeight);
  const useThreaded = nativeTarget !== null && probeNvencCaps(cudaOrdinal).available;

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
    estimator?.close();
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
  // them — measured ~212 fps vs ~163 fps for the threaded pipeline at 1080p.
  // Only NR at 1:1 qualifies (no upscale) with an NVENC codec at even, in-cap
  // dimensions. motion is ignored: feature 18 consumes no motion vectors, so
  // motion="flow" would only burn optical-flow time here.
  const nrNative = options.engine === "nr" && !upscaling && options.runtimeDir ? nvencNativeTarget(encode.codec, target.width, target.height) : null;
  if (nrNative && probeNvencCaps(cudaOrdinal).available) return runGpuResidentNr(job, nrNative);
  return runEngineJob(job);
}
