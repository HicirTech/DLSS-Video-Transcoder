/**
 * Video frame generation: ffmpeg decodes to raw RGBA, each frame plus a
 * synthesised optical-flow motion field goes to the DLSS Frame Generation
 * worker, the interpolated frames it returns are interleaved before the real
 * frame, and a second ffmpeg encodes the result at the multiplied frame rate.
 */
import { basename, dirname, extname, join } from "node:path";
import type { EncodeSettings } from "../server/api-types.ts";
import { DlssgSession, probeDlssg } from "./dlssg.ts";
import { resolveEncodeCodec } from "./encode-select.ts";
import { createMotionEstimator, encodeMotionR16G16 } from "./flow.ts";
import { tryCreateNvofBackend } from "./nvof.ts";
import { formatRational, parseRational, ratMul, rational } from "./nut.ts";
import { findTool } from "./tools.ts";
import { encoderArgs, probeVideo } from "./video.ts";

export interface FrameGenOptions {
  input: string;
  output?: string;
  /** Output-to-input frame ratio (2 = double the frame rate). */
  multiplier: number;
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
  inputFrames: number;
  outputFrames: number;
  multiplier: number;
  ms: number;
}

/** Reads exact-size frames from a byte stream of arbitrary chunks. */
class FrameReader {
  private pending: Uint8Array[] = [];
  private bytes = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async next(size: number): Promise<Uint8Array | null> {
    while (this.bytes < size) {
      const { value, done } = await this.reader.read();
      if (done) break;
      if (value?.byteLength) { this.pending.push(value); this.bytes += value.byteLength; }
    }
    if (this.bytes < size) return null;
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const chunk = this.pending[0]!;
      const take = Math.min(chunk.byteLength, size - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) this.pending.shift();
      else this.pending[0] = chunk.subarray(take);
    }
    this.bytes -= size;
    return out;
  }
}

export function defaultFrameGenOutput(input: string): string {
  const ext = extname(input);
  return join(dirname(input), `${basename(input, ext)}.dlssg.mp4`);
}

export async function processFrameGen(options: FrameGenOptions): Promise<FrameGenResult> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  if (!ffmpeg || !ffprobe)
    throw new Error("ffmpeg and ffprobe are required for frame generation (install with `winget install Gyan.FFmpeg` or set FFMPEG_PATH / FFPROBE_PATH).");
  const multiplier = Math.max(2, Math.round(options.multiplier));
  const generatedCount = multiplier - 1;

  const workerDir = join(options.runtimeDir, "dlssg");
  const caps = await probeDlssg(workerDir);
  if (!caps.available) throw new Error(`DLSS Frame Generation is not available: ${caps.detail}`);
  if (generatedCount > caps.multiFrameCountMax) {
    throw new Error(`Frame-rate multiplier ${multiplier}x is more than this GPU/runtime supports (maximum ${caps.multiFrameCountMax + 1}x). Use a lower --multiplier.`);
  }

  const info = probeVideo(ffprobe, options.input);
  const width = info.width;
  const height = info.height;
  const frameBytes = width * height * 4;
  const outputFps = info.fps * multiplier;
  const output = options.output ?? defaultFrameGenOutput(options.input);
  progress(0, `source ${width}x${height} ${info.codec} ${info.fpsText} fps, ${info.frames ?? "?"} frames; ${multiplier}x -> ${outputFps.toFixed(2)} fps`);

  const decoder = Bun.spawn([ffmpeg, "-v", "error", "-nostdin", "-i", options.input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const audioArgs = info.hasAudio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"] : ["-an"];
  // Exact rational output rate (source rate x multiplier) so 29.97 -> 59.94 etc.
  // never drifts from a rounded float over a long clip.
  const outputRate = formatRational(ratMul(parseRational(info.fpsText), rational(multiplier)));
  // GPU encode by default; falls back to CPU libx264 if NVENC will not run.
  const resolvedCodec = resolveEncodeCodec(options.codec ?? "h264_nvenc", ffmpeg);
  if (resolvedCodec.note) progress(0, resolvedCodec.note);
  const codecArgs = encoderArgs({ codec: resolvedCodec.codec, quality: options.quality ?? 20, container: "mp4", copyAudio: true });
  const encoder = Bun.spawn(
    [ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", outputRate, "-i", "pipe:0", "-i", options.input, "-map", "0:v:0", ...audioArgs, ...codecArgs, "-movflags", "+faststart", "-shortest", output],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );

  const session = await DlssgSession.open(workerDir, { width, height, frameCount: info.frames ?? 1, generatedCount });
  // Prefer the GPU optical-flow engine (NVOFA) for the motion field; fall back to CPU.
  const nvof = tryCreateNvofBackend(width, height);
  const estimator = createMotionEstimator(width, height, nvof ? { backend: nvof } : {});
  progress(0, nvof ? "optical flow: NVIDIA hardware (NVOFA)" : "optical flow: CPU block matching (NVOFA unavailable)");
  const zeros = new Uint16Array(width * height * 2);
  const reader = new FrameReader(decoder.stdout as ReadableStream<Uint8Array>);
  const stdin = encoder.stdin as { write(b: Uint8Array): unknown; flush(): number | Promise<number>; end(): unknown };

  // Write with backpressure only; the final stdin.end() flushes the remainder.
  // Flushing every frame drained the pipe and stalled the loop.
  const write = async (frame: Uint8Array): Promise<void> => {
    const w = stdin.write(frame);
    if (w instanceof Promise) await w;
  };

  let inputFrames = 0;
  let outputFrames = 0;
  try {
    for (;;) {
      const rgba = await reader.next(frameBytes);
      if (!rgba) break;
      const guide = estimator.process(rgba);
      const motion = guide.motion ? encodeMotionR16G16(guide.motion) : zeros;
      const generated = await session.processFrame(rgba, motion, inputFrames, inputFrames === 0 || guide.reset, BigInt(inputFrames), 1n);
      for (const frame of generated) { await write(frame); outputFrames++; }
      await write(rgba);
      outputFrames++;
      inputFrames++;
      const total = info.frames;
      progress(total ? Math.min(0.98, inputFrames / total) : 0.5, `frame ${inputFrames}/${total ?? "?"}`, inputFrames);
    }
    stdin.end();
  } finally {
    estimator.close();
    await session.close();
  }

  const [decodeExit, encodeExit] = await Promise.all([decoder.exited, encoder.exited]);
  const encodeErr = (await new Response(encoder.stderr).text()).trim();
  if (decodeExit !== 0) throw new Error(`ffmpeg decode failed (${decodeExit})`);
  if (encodeExit !== 0) throw new Error(`ffmpeg encode failed (${encodeExit}): ${encodeErr}`);
  if (inputFrames === 0) throw new Error("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
  progress(1, `generated ${outputFrames} frames from ${inputFrames} (${multiplier}x)`);
  return { output, width, height, sourceFps: info.fps, outputFps, inputFrames, outputFrames, multiplier, ms: Math.round(performance.now() - started) };
}
