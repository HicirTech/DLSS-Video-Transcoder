/**
 * Main-thread handle for the frame-generation encode worker, plus the ffmpeg
 * argv the worker runs. Writes are accepted ahead of the encoder so encoding
 * overlaps the rest of the pipeline, bounded so a fast producer cannot buy
 * throughput with unbounded memory.
 */
import { type EncodeSettings, FRAME_GEN_CONTAINER } from "../server/api-types.ts";
import { aspectArgs, audioArgs, encoderArgs, faststartArgs, muxCopyArgs } from "./ffmpeg-args.ts";
import { FRAMEGEN_CUDA_DEVICE } from "./framegen-plan.ts";
import { formatRational, type Rational } from "./rational.ts";
import { nvencNativeTarget } from "./video.ts";
import { abortWorkers } from "./worker-abort.ts";
import type { FramegenEncodeOpen, FramegenEncodeOut } from "./workers/framegen-encode-worker.ts";

export interface FrameGenEncodeArgs {
  ffmpeg: string;
  /** Source file, re-opened as a second input only when its audio is carried over. */
  input: string;
  output: string;
  width: number;
  height: number;
  targetRate: Rational;
  /** Source display aspect to re-state on the output; null for a square-pixel source. */
  displayAspect: Rational | null;
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
export function buildFrameGenEncodeArgs(spec: FrameGenEncodeArgs): FramegenEncodeOpen {
  const { ffmpeg, input, output, width, height, targetRate, codec, quality, hasAudio, displayAspect } = spec;
  const outputRate = formatRational(targetRate);
  // Null for CPU and AV1 codecs, and for dimensions NVENC will not take.
  const nativeTarget = nvencNativeTarget(codec, width, height);
  /** Second input (audio only) and the video map, identical on both paths. */
  const inputsAndMap = [...(hasAudio ? ["-i", input] : []), "-map", "0:v:0"];
  /**
   * No -shortest: the writer emits exactly ceil(decodedDuration * rate) frames,
   * so the video already spans the DECODED length and the audio is kept whole.
   * video_track_timescale = the rate numerator makes one frame exactly `den`
   * ticks, so the mp4 timeline is exact and ffprobe's base-rate guess comes back
   * equal to the target rather than near it.
   */
  const timescale = ["-video_track_timescale", String(targetRate.num)];
  return {
    type: "open",
    ffmpeg,
    nvencArgs: nativeTarget
      ? muxCopyArgs({
          demux: nativeTarget.demux, frameRate: outputRate, audioSource: hasAudio ? input : null,
          container: FRAME_GEN_CONTAINER, displayAspect, size: { width, height }, extra: timescale, output,
        })
      : [],
    rawArgs: [
      "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`,
      "-framerate", outputRate, "-i", "pipe:0", ...inputsAndMap, ...audioArgs(hasAudio, FRAME_GEN_CONTAINER),
      // The device is fixed for frame generation; FRAMEGEN_CUDA_DEVICE says which and why.
      ...encoderArgs({ codec, quality, container: FRAME_GEN_CONTAINER, copyAudio: true }, FRAMEGEN_CUDA_DEVICE),
      ...aspectArgs(displayAspect, width, height, null),
      ...timescale, ...faststartArgs(FRAME_GEN_CONTAINER), output,
    ],
    nvenc: nativeTarget
      ? { width, height, fpsNum: Number(targetRate.num), fpsDen: Number(targetRate.den), codec: nativeTarget.codec, cq: quality }
      : null,
  };
}

/** Frames the sink accepts ahead of the encoder; the bound on the memory a fast producer can buy. */
const MAX_FRAMES_IN_FLIGHT = 8;

/**
 * Main-thread handle for the encode worker. write() resolves as soon as the
 * frame is accepted, with at most MAX_FRAMES_IN_FLIGHT frames in flight, so encoding
 * overlaps the rest of the pipeline while staying in display order (the worker
 * processes requests through one promise chain) and bounded in memory.
 */
export class EncodeSink {
  usesNvenc = false;
  note = "";
  private written = 0;
  /** The worker thread died: it can answer nothing, so abort() does not ask it to. */
  private crashed = false;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private failure: Error | null = null;
  private openSettle: { resolve: (sink: EncodeSink) => void; reject: (error: Error) => void } | null = null;
  private finishSettle: { resolve: () => void; reject: (error: Error) => void } | null = null;

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as FramegenEncodeOut;
      if (m.type === "opened") {
        this.usesNvenc = m.nvenc;
        this.note = m.note;
        const settle = this.openSettle;
        this.openSettle = null;
        settle?.resolve(this);
      } else if (m.type === "encoded") {
        this.inFlight--;
        this.written++;
        this.waiters.shift()?.();
      } else if (m.type === "done") {
        const settle = this.finishSettle;
        this.finishSettle = null;
        settle?.resolve();
      } else if (m.type === "error") {
        this.fail(new Error(m.message));
      }
    };
    worker.addEventListener("error", (e) => {
      this.crashed = true;
      this.fail(new Error(`frame-generation encode worker crashed: ${(e as ErrorEvent).message}`));
    });
  }

  /** Frames the worker has written into ffmpeg's stdin: the count partial-output.ts judges ownership by. */
  get framesWritten(): number {
    return this.written;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const open = this.openSettle;
    this.openSettle = null;
    open?.reject(this.failure);
    const finish = this.finishSettle;
    this.finishSettle = null;
    finish?.reject(this.failure);
    // Wake every writer so it observes the failure instead of waiting for a credit that will never come.
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** `createWorker` starts the encode worker's thread; tests hand in a stand-in. */
  static async open(message: FramegenEncodeOpen, createWorker: (script: URL) => Worker = (script) => new Worker(script.href)): Promise<EncodeSink> {
    const worker = createWorker(new URL("./workers/framegen-encode-worker.ts", import.meta.url));
    const sink = new EncodeSink(worker);
    try {
      return await new Promise<EncodeSink>((resolve, reject) => {
        sink.openSettle = { resolve, reject };
        worker.postMessage(message);
      });
    } catch (error) {
      // No sink reaches the caller, so nobody else can end this thread.
      sink.close();
      throw error;
    }
  }

  async write(rgba: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    while (this.inFlight >= MAX_FRAMES_IN_FLIGHT) {
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
    if (!this.crashed) await abortWorkers([this.worker]);
    this.close();
  }

  close(): void {
    try { this.worker.terminate(); } catch {}
  }
}
