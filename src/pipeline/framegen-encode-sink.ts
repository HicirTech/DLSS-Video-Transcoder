/**
 * Main-thread handle for the frame-generation encode worker, plus the ffmpeg
 * argv the worker runs. Writes are accepted ahead of the encoder so encoding
 * overlaps the rest of the pipeline, bounded so a fast producer cannot buy
 * throughput with unbounded memory.
 */
import type { EncodeSettings } from "../server/api-types.ts";
import type { NvencSdkCodec } from "./nvenc.ts";
import { formatRational, type Rational } from "./rational.ts";
import { encoderArgs, nvencNativeTarget } from "./video.ts";

/**
 * How long abort() waits for the worker to kill its ffmpeg and release the
 * output file before giving up and terminating the thread regardless.
 */
const ABORT_TIMEOUT_MS = 5000;

export interface FrameGenEncodeArgs {
  ffmpeg: string;
  /** Source file, re-opened as a second input only when its audio is carried over. */
  input: string;
  output: string;
  width: number;
  height: number;
  targetRate: Rational;
  codec: EncodeSettings["codec"];
  quality: number;
  hasAudio: boolean;
}

/**
 * The two argv the worker chooses between: an in-process NVENC elementary
 * stream that ffmpeg only muxes, and a rawvideo pipe ffmpeg encodes itself.
 * NVENC is preferred because it spares ffmpeg an 8 MB/frame ingest; the worker
 * falls back to the raw argv when the encoder will not open.
 *
 * ffmpeg options are positional, so the shared prefix stops at `-map`: putting
 * `-c:v copy` before the second `-i` would attach it to that input instead of
 * the output.
 */
export function buildFrameGenEncodeArgs(spec: FrameGenEncodeArgs): OpenEncode {
  const { ffmpeg, input, output, width, height, targetRate, codec, quality, hasAudio } = spec;
  const outputRate = formatRational(targetRate);
  // Null for CPU and AV1 codecs, and for dimensions NVENC will not take.
  const nativeTarget = nvencNativeTarget(codec, width, height);
  const audioArgs = hasAudio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"] : ["-an"];
  /** Second input (audio only) and the video map, identical on both paths. */
  const inputsAndMap = [...(hasAudio ? ["-i", input] : []), "-map", "0:v:0"];
  /**
   * No -shortest: the writer emits exactly ceil(duration * rate) frames, so the
   * video already spans the source duration and the audio track is kept whole.
   * video_track_timescale = the rate numerator makes one frame exactly `den`
   * ticks, so the mp4 timeline is exact and ffprobe's base-rate guess comes back
   * equal to the target rather than near it.
   */
  const muxTail = ["-video_track_timescale", String(targetRate.num), "-movflags", "+faststart", output];
  return {
    type: "open",
    ffmpeg,
    // NVENC emits Annex-B and the mp4 muxer converts it to length-prefixed, so
    // `copy` needs no bitstream filter.
    nvencArgs: nativeTarget
      ? ["-v", "error", "-y", "-f", nativeTarget.demux, "-framerate", outputRate, "-i", "pipe:0", ...inputsAndMap, "-c:v", "copy", ...audioArgs, ...muxTail]
      : [],
    rawArgs: [
      "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`,
      "-framerate", outputRate, "-i", "pipe:0", ...inputsAndMap, ...audioArgs,
      ...encoderArgs({ codec, quality, container: "mp4", copyAudio: true }),
      ...muxTail,
    ],
    nvenc: nativeTarget
      ? { width, height, fpsNum: Number(targetRate.num), fpsDen: Number(targetRate.den), codec: nativeTarget.codec, cq: quality }
      : null,
  };
}
export interface OpenEncode {
  type: "open";
  ffmpeg: string;
  nvencArgs: string[];
  rawArgs: string[];
  nvenc: { width: number; height: number; fpsNum: number; fpsDen: number; codec: NvencSdkCodec; cq: number } | null;
}

/**
 * Main-thread handle for the encode worker. write() resolves as soon as the
 * frame is accepted, with at most `maxFramesInFlight` frames in flight, so encoding
 * overlaps the rest of the pipeline while staying in display order (the worker
 * processes requests through one promise chain) and bounded in memory.
 */
export class EncodeSink {
  usesNvenc = false;
  note = "";
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private failure: Error | null = null;
  private openSettle: { resolve: (sink: EncodeSink) => void; reject: (error: Error) => void } | null = null;
  private finishSettle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private abortSettle: (() => void) | null = null;

  private constructor(private readonly worker: Worker, private readonly maxFramesInFlight: number) {
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as { type: string; nvenc?: boolean; note?: string; message?: string };
      if (m.type === "opened") {
        this.usesNvenc = Boolean(m.nvenc);
        this.note = m.note ?? "";
        const settle = this.openSettle;
        this.openSettle = null;
        settle?.resolve(this);
      } else if (m.type === "encoded") {
        this.inFlight--;
        this.waiters.shift()?.();
      } else if (m.type === "done") {
        const settle = this.finishSettle;
        this.finishSettle = null;
        settle?.resolve();
      } else if (m.type === "aborted") {
        const settle = this.abortSettle;
        this.abortSettle = null;
        settle?.();
      } else if (m.type === "error") {
        this.fail(new Error(m.message ?? "frame-generation encode worker failed"));
      }
    };
    worker.addEventListener("error", (e) => this.fail(new Error(`frame-generation encode worker crashed: ${(e as ErrorEvent).message}`)));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const open = this.openSettle;
    this.openSettle = null;
    open?.reject(this.failure);
    const finish = this.finishSettle;
    this.finishSettle = null;
    finish?.reject(this.failure);
    const abort = this.abortSettle;
    this.abortSettle = null;
    abort?.();
    // Wake every writer so it observes the failure instead of waiting for a credit that will never come.
    for (const wake of this.waiters.splice(0)) wake();
  }

  static open(message: OpenEncode, maxFramesInFlight = 8): Promise<EncodeSink> {
    const worker = new Worker(new URL("./workers/framegen-encode-worker.ts", import.meta.url).href);
    const sink = new EncodeSink(worker, maxFramesInFlight);
    return new Promise<EncodeSink>((resolve, reject) => {
      sink.openSettle = { resolve, reject };
      worker.postMessage(message);
    });
  }

  async write(rgba: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    while (this.inFlight >= this.maxFramesInFlight) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.failure) throw this.failure;
    }
    this.inFlight++;
    this.worker.postMessage({ type: "frame", rgba });
  }

  /** Flush the encoder, close ffmpeg's stdin and wait for it to exit cleanly. */
  finish(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      this.finishSettle = { resolve, reject };
      this.worker.postMessage({ type: "finish" });
    });
  }

  /** Kill ffmpeg and wait for it to release the output file so the caller can delete it. */
  async abort(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.abortSettle = resolve;
      try {
        this.worker.postMessage({ type: "abort" });
      } catch {
        resolve();
        return;
      }
      setTimeout(resolve, ABORT_TIMEOUT_MS);
    });
    this.close();
  }

  close(): void {
    try { this.worker.terminate(); } catch {}
  }
}
