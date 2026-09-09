/**
 * Video job: ffmpeg decodes to raw RGBA frames on a pipe, every frame goes
 * through the engine, and a second ffmpeg encodes the result while copying
 * the original audio. ffmpeg / ffprobe are external tools found via tools.ts.
 */
import { basename, dirname, extname, join } from "node:path";
import type { EncodeSettings, EngineKind, MotionKind, NrSettings, ScaleSettings } from "../server/api-types.ts";
import { DEFAULT_ENCODE_SETTINGS } from "../server/api-types.ts";
import { createEngine } from "./engine.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { createMotionEstimator } from "./flow.ts";
import { tryCreateNvofBackend } from "./nvof.ts";
import { openGpu } from "./gpu.ts";
import { resolveTargetSize } from "./image.ts";
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
  width: number;
  height: number;
  fps: number;
  fpsText: string;
  frames: number | null;
  duration: number | null;
  codec: string;
  hasAudio: boolean;
}

function parseRate(text: string | undefined): number {
  if (!text) return 0;
  const [num, den] = text.split("/").map(Number);
  if (!num) return 0;
  return den ? num / den : num;
}

export function probeVideo(ffprobe: string, input: string): VideoInfo {
  const proc = Bun.spawnSync(
    [
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration",
      "-of",
      "json",
      input,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) throw new Error(`ffprobe could not read this file as video: ${new TextDecoder().decode(proc.stderr).trim()}`);
  const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
    streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; nb_frames?: string }[];
    format?: { duration?: string };
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error(`${input}: no video stream found in this file.`);
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30;
  const duration = data.format?.duration ? Number(data.format.duration) : null;
  const declared = video.nb_frames && video.nb_frames !== "N/A" ? Number(video.nb_frames) : null;
  return {
    width: video.width,
    height: video.height,
    fps,
    fpsText: video.avg_frame_rate && video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : (video.r_frame_rate ?? String(fps)),
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

/** Reads exact-size frames from a ReadableStream of arbitrary chunks. */
class FrameReader {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async next(frameBytes: number): Promise<Uint8Array | null> {
    while (this.pendingBytes < frameBytes) {
      const { value, done } = await this.reader.read();
      if (done) break;
      if (value && value.byteLength) {
        this.pending.push(value);
        this.pendingBytes += value.byteLength;
      }
    }
    if (this.pendingBytes < frameBytes) return null;
    const frame = new Uint8Array(frameBytes);
    let filled = 0;
    while (filled < frameBytes) {
      const chunk = this.pending[0]!;
      const take = Math.min(chunk.byteLength, frameBytes - filled);
      frame.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) this.pending.shift();
      else this.pending[0] = chunk.subarray(take);
    }
    this.pendingBytes -= frameBytes;
    return frame;
  }
}

/** Cheap scene-cut detector: mean absolute luma difference on a sparse grid. */
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
  // motion="flow" derives per-frame motion vectors from an optical-flow
  // estimator wired into the frame loop below; motion="none" feeds zero motion.
  const requestedEncode = options.encode ?? DEFAULT_ENCODE_SETTINGS;
  // Fall back from an NVENC codec to its CPU sibling if NVENC will not run here.
  const resolvedCodec = resolveEncodeCodec(requestedEncode.codec, ffmpeg, options.adapterIndex);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);
  const encode: EncodeSettings = { ...requestedEncode, codec: resolvedCodec.codec };
  const info = probeVideo(ffprobe, options.input);
  const target = resolveTargetSize(info.width, info.height, options.scale);
  const output = options.output ?? defaultVideoOutput(options.input, options.engine, encode.container);
  // SR upscales inside DLSS: decode at source size and let the engine write the
  // target size. Other engines get frames pre-scaled to the target by ffmpeg.
  const upscaling = options.engine === "sr";
  const renderWidth = upscaling ? info.width : target.width;
  const renderHeight = upscaling ? info.height : target.height;
  progress(0, `source ${info.width}x${info.height} ${info.codec} ${info.fpsText} fps, ${info.frames ?? "?"} frames; ${upscaling ? `upscaling to ${target.width}x${target.height}` : `working size ${target.width}x${target.height}`}`);

  const session = openGpu({ adapterIndex: options.adapterIndex, debugLayer: options.debugLayer });
  const engine = createEngine(options.engine, session, {
    width: renderWidth,
    height: renderHeight,
    outputWidth: upscaling ? target.width : undefined,
    outputHeight: upscaling ? target.height : undefined,
    settings: options.settings,
    runtimeDir: options.runtimeDir,
    dllDir: options.dllDir,
    appDataPath: options.appDataPath,
  });
  const outWidth = engine.outputWidth;
  const outHeight = engine.outputHeight;

  const decodeArgs = [ffmpeg, "-v", "error", "-nostdin", "-i", options.input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba"];
  if (renderWidth !== info.width || renderHeight !== info.height) decodeArgs.push("-vf", `scale=${renderWidth}:${renderHeight}:flags=lanczos`);
  decodeArgs.push("pipe:1");
  const decoder = Bun.spawn(decodeArgs, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });

  // Only open the source as a second input when we actually copy its audio —
  // otherwise ffmpeg would needlessly demux/decode the whole source again,
  // which dominated the per-frame time (the raw video pipe is the real cost).
  const wantAudio = info.hasAudio && encode.copyAudio;
  const audioArgs = wantAudio ? ["-map", "1:a:0", ...(encode.container === "mkv" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"])] : ["-an"];
  const encodeArgs = [
    ffmpeg,
    "-v",
    "error",
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${outWidth}x${outHeight}`,
    "-r",
    info.fpsText,
    "-i",
    "pipe:0",
    ...(wantAudio ? ["-i", options.input] : []),
    "-map",
    "0:v:0",
    ...audioArgs,
    ...encoderArgs(encode),
    ...(encode.container === "mp4" || encode.container === "mov" ? ["-movflags", "+faststart"] : []),
    ...(wantAudio ? ["-shortest"] : []),
    output,
  ];
  const encoder = Bun.spawn(encodeArgs, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });

  // Decoded frames arrive at the render size (source for SR, target otherwise).
  const frameBytes = renderWidth * renderHeight * 4;
  const reader = new FrameReader(decoder.stdout);
  const cuts = new SceneCutDetector(renderWidth, renderHeight);
  let estimator: ReturnType<typeof createMotionEstimator> | null = null;
  if (options.motion === "flow") {
    // Prefer the GPU optical-flow engine (NVOFA); fall back to the CPU matcher.
    const nvof = tryCreateNvofBackend(renderWidth, renderHeight);
    estimator = createMotionEstimator(renderWidth, renderHeight, nvof ? { backend: nvof } : {});
    progress(0, nvof ? "optical flow: NVIDIA hardware (NVOFA)" : "optical flow: CPU block matching (NVOFA unavailable)");
  }
  let frames = 0;
  let sceneCuts = 0;
  try {
    // Decoding is 8 MB/frame of rawvideo over a pipe while the GPU work is ~1 ms;
    // the loop is I/O-bound, so prefetch the next frame's decode so it overlaps
    // with the current frame's GPU pass + encoder write (which use other pipes).
    let pending = reader.next(frameBytes);
    for (;;) {
      const rgba = await pending;
      if (!rgba) break;
      pending = reader.next(frameBytes); // start the next decode-read immediately
      let reset: boolean;
      let motion: Float32Array | null = null;
      if (estimator) {
        const guide = estimator.process(rgba);
        reset = frames === 0 || guide.reset;
        motion = guide.motion;
        if (guide.reset && frames > 0) sceneCuts++;
      } else {
        const cut = frames > 0 && cuts.isCut(rgba);
        if (cut) sceneCuts++;
        else if (frames === 0) cuts.isCut(rgba);
        reset = frames === 0 || cut;
      }
      const result = engine.process({ rgba, reset, motion });
      // Write with backpressure only: await when the sink buffer is full, but do
      // not flush every frame (that drained the pipe and stalled the loop). The
      // final stdin.end() flushes whatever remains.
      const wrote = encoder.stdin.write(result);
      if (wrote instanceof Promise) await wrote;
      frames++;
      const total = info.frames;
      progress(total ? Math.min(0.98, frames / total) : 0.5, `frame ${frames}/${total ?? "?"}`, frames);
    }
    encoder.stdin.end();
  } finally {
    estimator?.close();
    engine.close();
    session.close();
  }
  const [decodeExit, encodeExit] = await Promise.all([decoder.exited, encoder.exited]);
  const decodeErr = (await new Response(decoder.stderr).text()).trim();
  const encodeErr = (await new Response(encoder.stderr).text()).trim();
  if (decodeExit !== 0) throw new Error(`ffmpeg decode failed (${decodeExit}): ${decodeErr}`);
  if (encodeExit !== 0) throw new Error(`ffmpeg encode failed (${encodeExit}): ${encodeErr}`);
  if (frames === 0) throw new Error("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
  progress(1, `encoded ${frames} frames to ${output}${sceneCuts ? ` (${sceneCuts} scene cuts reset history)` : ""}`);
  return { output, width: outWidth, height: outHeight, fps: info.fps, frames, sceneCuts, engine: options.engine, ms: Math.round(performance.now() - started) };
}
