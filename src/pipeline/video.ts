/**
 * Video job: ffmpeg decodes to raw RGBA frames on a pipe, every frame goes
 * through the engine, and the result is encoded with the original audio copied
 * across. Owns the choice between the three encode paths (GPU-resident async,
 * threaded NVENC, single-thread rawvideo) and the GPU session's lifetime.
 * ffmpeg / ffprobe are external tools found via tools.ts.
 */
import { basename, dirname, extname, join } from "node:path";
import type { EncodeSettings, EngineKind, MotionKind, NrSettings, ScaleSettings } from "../server/api-types.ts";
import { DEFAULT_ENCODE_SETTINGS } from "../server/api-types.ts";
import { createEngine, type Engine } from "./engine.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { ratMul, type Rational, rational } from "./rational.ts";
import { createMotionEstimator } from "./flow.ts";
import { FrameReader } from "./frame-reader.ts";
import { probeNvencCaps, type NvencSdkCodec } from "./nvenc.ts";
import { runThreadedEncode } from "./threaded-encode.ts";
import { runAsyncNrEncode } from "./async-nr-encode.ts";
import { tryCreateNvofBackend } from "./nvof.ts";
import { DXGI_FORMAT_R8G8B8A8_UNORM, linearLayout } from "../native/d3d12.ts";
import { openGpu } from "./gpu.ts";
import { resolveTargetSize } from "./image.ts";
import { evenSize } from "./resize.ts";
import { findTool } from "./tools.ts";

export interface VideoJobOptions {
  input: string;
  output?: string;
  engine: EngineKind;
  motion: MotionKind;
  scale: ScaleSettings;
  settings: NrSettings;
  encode?: EncodeSettings;
  adapterIndex?: number;
  debugLayer?: boolean;
  runtimeDir?: string;
  /** Specific DLSS DLL folder to load (version switching); defaults to the runtime feature folder. */
  dllDir?: string;
  appDataPath?: string;
  /** `frames` is set for per-frame updates so callers can skip logging them. */
  onProgress?: (fraction: number, message: string, frames?: number) => void;
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

export interface VideoInfo {
  /** Display width: already transposed when the stream carries a 90/270 rotation. */
  width: number;
  height: number;
  /** Display-matrix rotation in degrees, 0 when the stream carries none. */
  rotation: number;
  /**
   * Display aspect ratio to re-state on the output; null when the source is
   * square-pixel or declares nothing, so there is nothing to restore. DAR rather
   * than the raw sample aspect because every path here rescales, and DAR is what
   * survives a rescale; ffmpeg's -aspect takes it directly.
   */
  displayAspect: Rational | null;
  fps: number;
  /** Measured average rate (avg_frame_rate) when available, else the nominal rate. */
  fpsText: string;
  /** Nominal stream rate (r_frame_rate): the exact CFR clock frame generation plans on. */
  nominalFpsText: string;
  frames: number | null;
  duration: number | null;
  codec: string;
  hasAudio: boolean;
}

/**
 * The rate string itself, or null when ffmpeg could not use it. Both rate
 * fields go through this: they are passed verbatim as `-framerate`/`-r`, and
 * ffmpeg rejects "0/0" outright ("Unable to parse ... as video rate") instead
 * of defaulting, so an unusable rate has to fall through to the numeric one.
 */
function rateText(text: string | undefined): string | null {
  return parseRate(text) > 0 ? (text ?? null) : null;
}

function parseRate(text: string | undefined): number {
  if (!text) return 0;
  const [n, d] = text.split("/");
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (d === undefined) return num;
  const den = Number(d);
  // "1/0" is not 1: ffprobe emits it for a stream whose duration is zero, and
  // ffmpeg rejects it as argv, so it has to fall through to the numeric default.
  return Number.isFinite(den) && den > 0 ? num / den : 0;
}

/**
 * What the decode pipe will actually emit, read from the decoder rather than
 * predicted. ffprobe prints the display-matrix angle as a truncated integer
 * (89 for 89.99), while ffmpeg's autorotate decides from the full-precision
 * angle with a half-degree tolerance, so no arithmetic on the printed value can
 * reproduce its decision — a matrix in (89.5, 90.0) transposes on decode while
 * the integer says 89, and one in (90.5, 91.0) does not while it says 90.
 *
 * showinfo logs at INFO, so this call must not pass `-v error`. Costs one
 * ffmpeg start plus one frame (~65 ms here, next to the ~62 ms ffprobe already
 * spends), which is why the caller only pays it when a rotation is present.
 */
function decodedFrameSize(ffmpeg: string, input: string): { width: number; height: number } | null {
  const proc = Bun.spawnSync([ffmpeg, "-hide_banner", "-nostdin", "-i", input, "-map", "0:v:0", "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const shown = /\ss:(\d+)x(\d+)\s/.exec(new TextDecoder().decode(proc.stderr));
  if (!shown) return null;
  return { width: Number(shown[1]), height: Number(shown[2]) };
}

/**
 * `ffmpeg` is optional: it is only spawned when the stream carries a rotation,
 * to confirm the geometry the decoder will hand over. Without it a rotated
 * source falls back to the angle-based guess, which is right for every exact
 * 90/180/270 matrix — the case phone footage produces.
 */
export function probeVideo(ffprobe: string, input: string, ffmpeg?: string): VideoInfo {
  const proc = Bun.spawnSync(
    [
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,r_frame_rate,avg_frame_rate,nb_frames:stream_side_data=rotation:format=duration",
      "-of",
      "json",
      input,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) throw new Error(`ffprobe could not read this file as video: ${new TextDecoder().decode(proc.stderr).trim()}`);
  const info = videoInfoFrom(JSON.parse(new TextDecoder().decode(proc.stdout)) as ProbeJson, input);
  if (info.rotation === 0 || !ffmpeg) return info;
  const decoded = decodedFrameSize(ffmpeg, input);
  if (!decoded || (decoded.width === info.width && decoded.height === info.height)) return info;
  // The decoder disagreed with the angle. It is the one feeding the pipeline,
  // so it wins; predicting its threshold is what caused the shear.
  return { ...info, width: decoded.width, height: decoded.height };
}

export interface ProbeJson {
  streams?: {
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    sample_aspect_ratio?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    nb_frames?: string;
    side_data_list?: { rotation?: number }[];
  }[];
  format?: { duration?: string };
}

/** Display-matrix rotation in degrees, normalised to (-180, 180]; 0 when the stream carries none. */
function rotationDegrees(sideData: { rotation?: number }[] | undefined): number {
  const raw = sideData?.find((s) => typeof s.rotation === "number")?.rotation;
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  const wrapped = ((Math.round(raw) % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * The display aspect ratio a non-square-pixel source must keep, from ffprobe's
 * sample_aspect_ratio ("8:9"; the field is absent for an mp4 with no pasp atom
 * — both measured). Null for 1:1, "0:1", "N/A" and a missing field, so a
 * square-pixel source adds no argv and its output is untouched. width/height
 * are the DISPLAY dimensions, already transposed for a 90/270 rotation; that
 * rotation turns the sample grid with the picture, so the sample aspect inverts
 * along with the geometry.
 */
function displayAspectOf(text: string | undefined, width: number, height: number, transposed: boolean): Rational | null {
  if (!text) return null;
  const [n, d] = text.split(":");
  const num = Number(n);
  const den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0 || num === den) return null;
  const [sarNum, sarDen] = transposed ? [den, num] : [num, den];
  return rational(sarNum * width, sarDen * height);
}

/** ffprobe's JSON as a VideoInfo. Separate from the spawn so it can be tested against odd streams. */
export function videoInfoFrom(data: ProbeJson, input: string): VideoInfo {
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error(`${input}: no video stream found in this file.`);
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30;
  const duration = data.format?.duration ? Number(data.format.duration) : null;
  const declared = video.nb_frames && video.nb_frames !== "N/A" ? Number(video.nb_frames) : null;
  // ffprobe reports the CODED size, but ffmpeg autorotates on decode, so a
  // portrait phone clip (coded 1920x1080, rotation 90) arrives as 1080x1920.
  // Report what the decoder emits: width*height is the same either way, so a
  // transposed frame reads as a whole frame and nothing downstream can notice.
  const rotation = rotationDegrees(video.side_data_list);
  const transposed = Math.abs(rotation) % 180 === 90;
  const displayWidth = transposed ? video.height : video.width;
  const displayHeight = transposed ? video.width : video.height;
  return {
    width: displayWidth,
    height: displayHeight,
    rotation,
    displayAspect: displayAspectOf(video.sample_aspect_ratio, displayWidth, displayHeight, transposed),
    fps,
    // Measured average first; the nominal CFR clock first for nominalFpsText.
    fpsText: rateText(video.avg_frame_rate) ?? rateText(video.r_frame_rate) ?? String(fps),
    nominalFpsText: rateText(video.r_frame_rate) ?? rateText(video.avg_frame_rate) ?? String(fps),
    frames: declared ?? (duration ? Math.round(duration * fps) : null),
    duration,
    codec: video.codec_name ?? "unknown",
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === "audio")),
  };
}

export function encoderArgs(encode: EncodeSettings): string[] {
  const q = String(Math.max(0, Math.min(51, Math.round(encode.quality))));
  switch (encode.codec) {
    case "h264":
      return ["-c:v", "libx264", "-preset", "medium", "-crf", q, "-pix_fmt", "yuv420p"];
    case "hevc":
      return ["-c:v", "libx265", "-preset", "medium", "-crf", q, "-pix_fmt", "yuv420p", "-tag:v", "hvc1"];
    case "av1":
      return ["-c:v", "libsvtav1", "-preset", "6", "-crf", q, "-pix_fmt", "yuv420p"];
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q, "-b:v", "0", "-pix_fmt", "yuv420p"];
    case "hevc_nvenc":
      return ["-c:v", "hevc_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q, "-b:v", "0", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"];
    case "av1_nvenc":
      return ["-c:v", "av1_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q, "-b:v", "0", "-pix_fmt", "yuv420p"];
    default:
      throw new Error(`Unknown codec "${String(encode.codec)}". Choose one of: h264, hevc, av1, h264_nvenc, hevc_nvenc, av1_nvenc.`);
  }
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

/**
 * Output argv that re-states the source's display aspect on a `width`x`height`
 * encode; empty for a square-pixel source, so the usual file is untouched.
 *
 * `demux` non-null means the video is stream-copied from an elementary stream,
 * which needs BOTH flags. -aspect writes the container tag, but with -c:v copy
 * ffmpeg tags the container from stream parameters it read before any filter
 * ran, so the aspect inside the bitstream would still claim 1:1. Measured with
 * the bundled ffmpeg: -aspect alone leaves the VUI at 1:1, the bitstream filter
 * alone leaves the container at 1:1, the pair agrees everywhere.
 */
export function aspectArgs(displayAspect: Rational | null, width: number, height: number, demux: string | null): string[] {
  if (!displayAspect) return [];
  const args = ["-aspect", `${displayAspect.num}:${displayAspect.den}`];
  if (!demux) return args;
  // The bitstream stores SAR: the sample shape that makes this pixel grid display at DAR.
  const sar = ratMul(displayAspect, rational(height, width));
  return [...args, "-bsf:v", `${demux}_metadata=sample_aspect_ratio=${sar.num}/${sar.den}`];
}

/** Parse an ffmpeg rate string ("30000/1001", "25") into integer num/den; 30/1 if unparseable. */
function rateParts(text: string): { num: number; den: number } {
  const [n, d] = text.split("/");
  const num = Number(n);
  const den = d ? Number(d) : 1;
  if (!Number.isFinite(num) || num <= 0 || !Number.isFinite(den) || den <= 0) return { num: 30, den: 1 };
  return { num: Math.round(num), den: Math.round(den) };
}

/**
 * Cheap scene-cut detector: mean absolute luma difference over a ~48x27 grid of
 * samples, so cost is independent of resolution. A mean above `threshold`
 * (default 40, in 0-255 luma units) counts as a cut and resets DLSS history.
 */
class SceneCutDetector {
  private previous: Float32Array | null = null;
  private readonly samples: Int32Array;

  constructor(width: number, height: number, private readonly threshold = 40) {
    const stepX = Math.max(1, Math.floor(width / 48));
    const stepY = Math.max(1, Math.floor(height / 27));
    const offsets: number[] = [];
    for (let y = stepY >> 1; y < height; y += stepY) for (let x = stepX >> 1; x < width; x += stepX) offsets.push((y * width + x) * 4);
    this.samples = Int32Array.from(offsets);
  }

  isCut(rgba: Uint8Array): boolean {
    const luma = new Float32Array(this.samples.length);
    for (let i = 0; i < this.samples.length; i++) {
      const o = this.samples[i]!;
      luma[i] = 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
    }
    let cut = false;
    if (this.previous) {
      let sum = 0;
      for (let i = 0; i < luma.length; i++) sum += Math.abs(luma[i]! - this.previous[i]!);
      cut = sum / luma.length > this.threshold;
    }
    this.previous = luma;
    return cut;
  }
}

export function defaultVideoOutput(input: string, engine: EngineKind, container: EncodeSettings["container"]): string {
  const ext = extname(input);
  return join(dirname(input), `${basename(input, ext)}.${engine}.${container}`);
}

export async function processVideo(options: VideoJobOptions): Promise<VideoJobResult> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  if (!ffmpeg || !ffprobe) {
    throw new Error("ffmpeg and ffprobe are required for video jobs (install with `winget install Gyan.FFmpeg` or set FFMPEG_PATH / FFPROBE_PATH)");
  }
  const requestedEncode = options.encode ?? DEFAULT_ENCODE_SETTINGS;
  // Resolve the codec before anything else: an NVENC request that cannot run
  // here degrades to its CPU sibling, and every path below branches on the result.
  const resolvedCodec = resolveEncodeCodec(requestedEncode.codec, ffmpeg, options.adapterIndex);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);
  const encode: EncodeSettings = { ...requestedEncode, codec: resolvedCodec.codec };
  const info = probeVideo(ffprobe, options.input, ffmpeg);
  // Every codec here encodes 4:2:0 (yuv420p / NVENC NV12), which requires even
  // width and height. resolveTargetSize leaves scale 'none' (the default) at the
  // raw source size, so an odd-sized source would only fail at encode time.
  const rawTarget = resolveTargetSize(info.width, info.height, options.scale);
  const target = { width: evenSize(rawTarget.width), height: evenSize(rawTarget.height) };
  const output = options.output ?? defaultVideoOutput(options.input, options.engine, encode.container);
  // SR upscales inside DLSS: decode at source size and let the engine write the
  // target size. Other engines get frames pre-scaled to the target by ffmpeg.
  const upscaling = options.engine === "sr";
  const renderWidth = upscaling ? info.width : target.width;
  const renderHeight = upscaling ? info.height : target.height;
  progress(0, `source ${info.width}x${info.height}${info.displayAspect ? ` (non-square pixels, display ${info.displayAspect.num}:${info.displayAspect.den})` : ""} ${info.codec} ${info.fpsText} fps, ${info.frames ?? "?"} frames; ${upscaling ? `upscaling to ${target.width}x${target.height}` : `working size ${target.width}x${target.height}`}`);

  const session = openGpu({ adapterIndex: options.adapterIndex, debugLayer: options.debugLayer });

  // Fastest path, tried first: DLSS output stays on the GPU and NVENC reads it
  // through a shared buffer, so the two overlap with no CPU frame copy between
  // them — measured ~212 fps vs ~163 fps for the threaded pipeline at 1080p.
  // Only NR at 1:1 qualifies (no upscale) with an NVENC codec at even, in-cap
  // dimensions. motion is ignored: feature 18 consumes no motion vectors, so
  // motion="flow" would only burn optical-flow time here.
  const nrNative = options.engine === "nr" && !upscaling && options.runtimeDir ? nvencNativeTarget(encode.codec, target.width, target.height) : null;
  // session.cudaOrdinal, not adapterIndex: see GpuSession.cudaOrdinal.
  const cudaOrdinal = session.cudaOrdinal;
  if (cudaOrdinal === null) {
    // Both GPU-side fast paths (in-process NVENC, hardware optical flow) run on
    // CUDA. Without a CUDA device for this adapter they cannot start, and the
    // job silently takes the slower ffmpeg encode and the CPU matcher instead.
    progress(0, `${session.adapter.info.name} has no CUDA device, so GPU encoding and hardware optical flow are unavailable; encoding through ffmpeg instead. Run \`probe\` to see which adapter to select.`);
  }
  if (nrNative && cudaOrdinal !== null && probeNvencCaps(cudaOrdinal).available) {
    try {
      const { num, den } = rateParts(info.fpsText);
      const layout = linearLayout(target.width, target.height, DXGI_FORMAT_R8G8B8A8_UNORM);
      const decodeArgs = [
        "-v", "error", "-nostdin", "-i", options.input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba",
        ...(target.width !== info.width || target.height !== info.height ? ["-vf", `scale=${target.width}:${target.height}:flags=lanczos`] : []),
        "pipe:1",
      ];
      const wantAudio = info.hasAudio && encode.copyAudio;
      const audioArgs = wantAudio ? ["-map", "1:a:0", ...(encode.container === "mkv" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"])] : ["-an"];
      const faststart = encode.container === "mp4" || encode.container === "mov" ? ["-movflags", "+faststart"] : [];
      const sinkArgs = [
        "-v", "error", "-y", "-f", nrNative.demux, "-framerate", info.fpsText, "-i", "pipe:0",
        ...(wantAudio ? ["-i", options.input] : []),
        "-map", "0:v:0", "-c:v", "copy", ...aspectArgs(info.displayAspect, target.width, target.height, nrNative.demux), ...audioArgs, ...faststart, output,
      ];
      const cuts = new SceneCutDetector(target.width, target.height);
      const guide = (rgba: Uint8Array, index: number): { reset: boolean; sceneCut: boolean } => {
        const cut = index > 0 && cuts.isCut(rgba);
        if (index === 0) cuts.isCut(rgba); // discarded result; the call is what primes the history
        return { reset: index === 0 || cut, sceneCut: cut };
      };
      progress(0, `encode: NVENC ${nrNative.codec} (GPU-resident async zero-copy pipeline)`);
      const { DlssNrSession } = await import("../ngx/nr-render.ts");
      const nr = DlssNrSession.open(session, { width: target.width, height: target.height, settings: options.settings, runtimeDir: options.runtimeDir!, dllDir: options.dllDir, appDataPath: options.appDataPath });
      try {
        const r = await runAsyncNrEncode({
          session, nr, ffmpeg, decodeArgs, sinkArgs,
          width: target.width, height: target.height, rowPitch: layout.rowPitch, totalBytes: layout.totalBytes,
          enc: { fpsNum: num, fpsDen: den, codec: nrNative.codec, cq: encode.quality, ordinal: cudaOrdinal },
          totalFrames: info.frames, guide, onProgress: progress,
        });
        if (r.frames === 0) throw new Error("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
        progress(1, `encoded ${r.frames} frames to ${output}${r.sceneCuts ? ` (${r.sceneCuts} scene cuts reset history)` : ""}`);
        return { output, width: target.width, height: target.height, fps: info.fps, frames: r.frames, sceneCuts: r.sceneCuts, engine: options.engine, ms: Math.round(performance.now() - started) };
      } finally {
        nr.close();
      }
    } finally {
      session.close();
    }
  }

  let engine: Engine;
  try {
    engine = createEngine(options.engine, session, {
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
  const outWidth = engine.outputWidth;
  const outHeight = engine.outputHeight;

  // Decode argv without the binary; both encode paths below spawn it themselves.
  const decodeArgv = [
    "-v", "error", "-nostdin", "-i", options.input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba",
    ...(renderWidth !== info.width || renderHeight !== info.height ? ["-vf", `scale=${renderWidth}:${renderHeight}:flags=lanczos`] : []),
    "pipe:1",
  ];

  // Only open the source as a second input when its audio is actually copied:
  // otherwise the encoder demuxes and decodes the whole source a second time,
  // which cost more per frame than the raw video pipe it was competing with.
  const wantAudio = info.hasAudio && encode.copyAudio;
  // Video is always input 0 (the pipe); audio, when copied, is input 1 (source).
  const audioArgs = wantAudio ? ["-map", "1:a:0", ...(encode.container === "mkv" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"])] : ["-an"];
  const faststart = encode.container === "mp4" || encode.container === "mov" ? ["-movflags", "+faststart"] : [];

  // Scene-cut / motion guide. Both backends keep a one-frame history, so `guide`
  // must be called exactly once per frame and in decode order.
  const cuts = new SceneCutDetector(renderWidth, renderHeight);
  let estimator: ReturnType<typeof createMotionEstimator> | null = null;
  if (options.motion === "flow") {
    try {
      const nvof = tryCreateNvofBackend(renderWidth, renderHeight, undefined, session.cudaOrdinal ?? 0);
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
    const cut = index > 0 && cuts.isCut(rgba);
    if (index === 0) cuts.isCut(rgba); // discarded result; the call is what primes the history
    return { reset: index === 0 || cut, motion: null, sceneCut: cut };
  };

  const frameBytes = renderWidth * renderHeight * 4;
  // Second choice: decode, DLSS and NVENC each on their own thread, encoding on
  // the GPU here (nvenc.ts) so ffmpeg only muxes the elementary stream
  // (-c:v copy). The stages are ~4-5 ms each at 1080p and ran at their sum when
  // serial. CPU/AV1 codecs, oversized frames, or an NVENC that will not come up
  // here fall through to the single-thread rawvideo path.
  const nativeTarget = nvencNativeTarget(encode.codec, outWidth, outHeight);
  const useThreaded = nativeTarget !== null && cudaOrdinal !== null && probeNvencCaps(cudaOrdinal).available;

  let frames = 0;
  let sceneCuts = 0;
  try {
    if (useThreaded && nativeTarget) {
      const { num, den } = rateParts(info.fpsText);
      const sinkArgs = [
        "-v", "error", "-y",
        // Annex-B elementary stream from NVENC on stdin: it carries no timing at
        // all, so -framerate is the only thing that lets the muxer stamp
        // timestamps. (mp4/mov converts Annex-B to length-prefixed internally.)
        "-f", nativeTarget.demux, "-framerate", info.fpsText, "-i", "pipe:0",
        ...(wantAudio ? ["-i", options.input] : []),
        "-map", "0:v:0", "-c:v", "copy",
        ...aspectArgs(info.displayAspect, outWidth, outHeight, nativeTarget.demux),
        ...audioArgs, ...faststart,
        // No -shortest here: with -c:v copy from a raw elementary stream it
        // drops the audio track outright. Safe to omit, because this path emits
        // one frame per source frame, so audio and video share the duration.
        output,
      ];
      progress(0, `encode: NVENC ${nativeTarget.codec} (threaded GPU pipeline, mux-only)`);
      const result = await runThreadedEncode({
        engine, ffmpeg, decodeArgs: decodeArgv, frameBytes, sinkArgs,
        enc: { width: outWidth, height: outHeight, fpsNum: num, fpsDen: den, codec: nativeTarget.codec, preset: "p5", cq: encode.quality, ordinal: cudaOrdinal },
        totalFrames: info.frames, guide, onProgress: progress,
      });
      frames = result.frames;
      sceneCuts = result.sceneCuts;
    } else {
      // Fallback: raw RGBA out to ffmpeg, which does the encode.
      const decoder = Bun.spawn([ffmpeg, ...decodeArgv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const encoder = Bun.spawn(
        [
          ffmpeg, "-v", "error", "-y",
          "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${outWidth}x${outHeight}`, "-r", info.fpsText, "-i", "pipe:0",
          ...(wantAudio ? ["-i", options.input] : []),
          "-map", "0:v:0", ...audioArgs, ...encoderArgs(encode), ...aspectArgs(info.displayAspect, outWidth, outHeight, null), ...faststart,
          ...(wantAudio ? ["-shortest"] : []),
          output,
        ],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      );
      const reader = new FrameReader(decoder.stdout);
      // Kept one frame ahead: the decode of frame n+1 overlaps the GPU pass on n.
      let pending = reader.next(frameBytes);
      for (;;) {
        const rgba = await pending;
        if (!rgba) break;
        pending = reader.next(frameBytes);
        const g = guide(rgba, frames);
        if (g.sceneCut) sceneCuts++;
        const result = engine.process({ rgba, reset: g.reset, motion: g.motion });
        const wrote = encoder.stdin.write(result);
        if (wrote instanceof Promise) await wrote;
        frames++;
        const total = info.frames;
        progress(total ? Math.min(0.98, frames / total) : 0.5, `frame ${frames}/${total ?? "?"}`, frames);
      }
      encoder.stdin.end();
      const [decodeExit, encodeExit] = await Promise.all([decoder.exited, encoder.exited]);
      const decodeErr = (await new Response(decoder.stderr).text()).trim();
      const encodeErr = (await new Response(encoder.stderr).text()).trim();
      if (decodeExit !== 0) throw new Error(`ffmpeg decode failed (${decodeExit}): ${decodeErr}`);
      if (encodeExit !== 0) throw new Error(`ffmpeg encode failed (${encodeExit}): ${encodeErr}`);
    }
  } finally {
    estimator?.close();
    engine.close();
    session.close();
  }
  if (frames === 0) throw new Error("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
  progress(1, `encoded ${frames} frames to ${output}${sceneCuts ? ` (${sceneCuts} scene cuts reset history)` : ""}`);
  return { output, width: outWidth, height: outHeight, fps: info.fps, frames, sceneCuts, engine: options.engine, ms: Math.round(performance.now() - started) };
}
