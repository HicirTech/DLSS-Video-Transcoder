/**
 * Encode-stage worker for the threaded video pipeline.
 *
 * Owns the CUDA context + NVENC encoder (nvenc.ts) and the mux-only ffmpeg on
 * its own OS thread, so GPU encode + bitstream muxing overlap with the main
 * thread's DLSS work and the decode thread's reads. Receives engine-output RGBA
 * frames as transferred ArrayBuffers, encodes each on the GPU, and pipes only
 * the compressed elementary stream to ffmpeg (-c:v copy).
 *
 * Frames are processed strictly in arrival order (a serial promise chain) so the
 * elementary stream stays in display order, matching NVENC's no-B-frame config.
 */
import { ffmpegFailedMessage } from "../ffmpeg-failure.ts";
import { MuxSink } from "../mux-sink.ts";
import { NvencEncoder, type NvencEncoderOptions } from "../nvenc.ts";
import { type AbortedReply, type AbortRequest, answerAbort } from "../worker-abort.ts";

/** Open the encoder and the mux ffmpeg, whose `sinkArgs` read the elementary stream on pipe:0. */
export interface EncodeOpen {
  type: "open";
  ffmpeg: string;
  sinkArgs: string[];
  /** Frames arrive over messages, so the encoder owns its input buffer: there is no `inputs` pool. */
  enc: Omit<NvencEncoderOptions, "inputs">;
}
/** One engine-output RGBA frame (its buffer transferred); `index` comes back in the "encoded" ack. */
export interface EncodeFrame { type: "frame"; index: number; buf: ArrayBuffer }
/** Every frame is sent: flush NVENC, close the mux and report "done". */
interface EncodeFinish { type: "finish" }
/** What the main thread sends the encode worker. */
type EncodeIn = EncodeOpen | EncodeFrame | EncodeFinish | AbortRequest;
/** What it answers. */
export type EncodeOut =
  | { type: "opened" }
  | { type: "encoded"; index: number }
  | { type: "done" }
  | { type: "error"; message: string }
  | AbortedReply;

declare const self: Worker;

const post = (message: EncodeOut): void => self.postMessage(message);

let encoder: NvencEncoder | null = null;
let sink: MuxSink | null = null;
let chain: Promise<void> = Promise.resolve();
/** No more work: set by a failure or an abort. */
let stopped = false;

function fail(message: string): void {
  if (stopped) return;
  stopped = true;
  post({ type: "error", message });
}

/** Both finish and abort reach this, in either order; the second call does nothing. */
function closeEncoder(): void {
  encoder?.close();
  encoder = null;
}

self.onmessage = (event: MessageEvent<EncodeIn>) => {
  const msg = event.data;
  if (msg.type === "open") {
    try {
      encoder = NvencEncoder.open(msg.enc);
      sink = MuxSink.spawn(msg.ffmpeg, msg.sinkArgs);
      post({ type: "opened" });
    } catch (error) {
      fail((error as Error).message ?? String(error));
    }
  } else if (msg.type === "frame") {
    chain = chain.then(async () => {
      if (stopped || !encoder || !sink) return;
      const packet = encoder.encode(new Uint8Array(msg.buf));
      await sink.write(packet);
      post({ type: "encoded", index: msg.index });
    }).catch(async (error) => fail(sink ? await sink.failureOf(error) : (error as Error).message ?? String(error)));
  } else if (msg.type === "abort") {
    // Immediate, not chained: frames still queued are dropped, the file is
    // released for deletion, and the GPU encoder is closed on this thread.
    stopped = true;
    void answerAbort(self, sink?.child ?? null, closeEncoder);
  } else if (msg.type === "finish") {
    chain = chain.then(async () => {
      if (stopped || !encoder || !sink) return;
      encoder.finish();
      const { code, stderr } = await sink.close();
      closeEncoder();
      if (code !== 0) { fail(ffmpegFailedMessage("mux", code, stderr)); return; }
      post({ type: "done" });
    }).catch((error) => fail((error as Error).message ?? String(error)));
  }
};
