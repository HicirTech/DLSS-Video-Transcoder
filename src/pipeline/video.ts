/**
 * Video job: ffmpeg decodes to raw RGBA frames on a pipe, every frame goes
 * through the engine, and a second ffmpeg encodes the result while copying
 * the original audio. ffmpeg / ffprobe are external tools found via tools.ts.
 */
import { basename, dirname, extname, join } from "node:path";
import type { EncodeSettings, EngineKind, MotionKind, NrSettings, ScaleSettings } from "../server/api-types.ts";
import { DEFAULT_ENCODE_SETTINGS } from "../server/api-types.ts";
import { createEngine } from "./engine.ts";
import { createMotionEstimator } from "./flow.ts";
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
  if (proc.exitCode !== 0) throw new Error(`ffprobe failed: ${new TextDecoder().decode(proc.stderr).trim()}`);
  const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
    streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; nb_frames?: string }[];
    format?: { duration?: string };
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error(`${input}: no video stream`);
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

function encoderArgs(encode: EncodeSettings): string[] {
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
      throw new Error(`Unknown codec ${String(encode.codec)}`);
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
  const encode = options.encode ?? DEFAULT_ENCODE_SETTINGS;
  const info = probeVideo(ffprobe, options.input);
  const target = resolveTargetSize(info.width, info.height, options.scale);
  const output = options.output ?? defaultVideoOutput(options.input, options.engine, encode.container);
  progress(0, `source ${info.width}x${info.height} ${info.codec} ${info.fpsText} fps, ${info.frames ?? "?"} frames; working size ${target.width}x${target.height}`);

  const session = openGpu({ adapterIndex: options.adapterIndex, debugLayer: options.debugLayer });
  const engine = createEngine(options.engine, session, {
    width: target.width,
    height: target.height,
    settings: options.settings,
    runtimeDir: options.runtimeDir,
    appDataPath: options.appDataPath,
  });
  const outWidth = engine.outputWidth;
  const outHeight = engine.outputHeight;

  const decodeArgs = [ffmpeg, "-v", "error", "-nostdin", "-i", options.input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba"];
  if (target.width !== info.width || target.height !== info.height) decodeArgs.push("-vf", `scale=${target.width}:${target.height}:flags=lanczos`);
  decodeArgs.push("pipe:1");
  const decoder = Bun.spawn(decodeArgs, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });

  const audioArgs = info.hasAudio && encode.copyAudio ? ["-map", "1:a:0", ...(encode.container === "mkv" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"])] : ["-an"];
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
    "-i",
    options.input,
    "-map",
    "0:v:0",
    ...audioArgs,
    ...encoderArgs(encode),
    ...(encode.container === "mp4" || encode.container === "mov" ? ["-movflags", "+faststart"] : []),
    "-shortest",
    output,
  ];
  const encoder = Bun.spawn(encodeArgs, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });

  const frameBytes = target.width * target.height * 4;
  const reader = new FrameReader(decoder.stdout);
  const cuts = new SceneCutDetector(target.width, target.height);
  const estimator = options.motion === "flow" ? createMotionEstimator(target.width, target.height) : null;
  let frames = 0;
  let sceneCuts = 0;
  try {
    for (;;) {
      const rgba = await reader.next(frameBytes);
      if (!rgba) break;
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
      const wrote = encoder.stdin.write(result);
      if (wrote instanceof Promise) await wrote;
      await encoder.stdin.flush();
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
  if (frames === 0) throw new Error("no frames were decoded");
  progress(1, `encoded ${frames} frames to ${output}${sceneCuts ? ` (${sceneCuts} scene cuts reset history)` : ""}`);
  return { output, width: outWidth, height: outHeight, fps: info.fps, frames, sceneCuts, engine: options.engine, ms: Math.round(performance.now() - started) };
}
