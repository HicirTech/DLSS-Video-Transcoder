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
import { NvencEncoder, type NvencSdkCodec } from "../nvenc.ts";
import { type AbortRequest, answerAbort } from "../worker-abort.ts";

interface OpenMsg {
  type: "open";
  ffmpeg: string;
  sinkArgs: string[];
  enc: { width: number; height: number; fpsNum: number; fpsDen: number; codec: NvencSdkCodec; cq?: number; ordinal: number };
}
interface FrameMsg { type: "frame"; index: number; buf: ArrayBuffer }
interface FinishMsg { type: "finish" }
type InMsg = OpenMsg | FrameMsg | FinishMsg | AbortRequest;

declare const self: Worker;

let encoder: NvencEncoder | null = null;
let sink: ReturnType<typeof Bun.spawn> | null = null;
let chain: Promise<void> = Promise.resolve();
/** No more work: set by a failure or an abort. */
let stopped = false;

function fail(message: string): void {
  if (stopped) return;
  stopped = true;
  self.postMessage({ type: "error", message });
}

/** Both finish and abort reach this, in either order; the second call does nothing. */
function closeEncoder(): void {
  encoder?.close();
  encoder = null;
}

self.onmessage = (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  if (msg.type === "open") {
    try {
      encoder = NvencEncoder.open(msg.enc);
      sink = Bun.spawn([msg.ffmpeg, ...msg.sinkArgs], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
      self.postMessage({ type: "opened" });
    } catch (error) {
      fail((error as Error).message ?? String(error));
    }
  } else if (msg.type === "frame") {
    chain = chain.then(async () => {
      if (stopped || !encoder || !sink) return;
      const pkt = encoder.encode(new Uint8Array(msg.buf));
      const wrote = (sink.stdin as { write(b: Uint8Array): unknown }).write(pkt);
      if (wrote instanceof Promise) await wrote;
      self.postMessage({ type: "encoded", index: msg.index });
    }).catch((error) => fail((error as Error).message ?? String(error)));
  } else if (msg.type === "abort") {
    // Immediate, not chained: frames still queued are dropped, the file is
    // released for deletion, and the GPU encoder is closed on this thread.
    stopped = true;
    void answerAbort(self, sink, closeEncoder);
  } else if (msg.type === "finish") {
    chain = chain.then(async () => {
      if (stopped || !encoder || !sink) return;
      encoder.finish();
      (sink.stdin as { end(): unknown }).end();
      const err = (await new Response(sink.stderr as ReadableStream<Uint8Array>).text()).trim();
      const code = await sink.exited;
      closeEncoder();
      if (code !== 0) { fail(`ffmpeg mux failed (${code}): ${err}`); return; }
      self.postMessage({ type: "done" });
    }).catch((error) => fail((error as Error).message ?? String(error)));
  }
};
