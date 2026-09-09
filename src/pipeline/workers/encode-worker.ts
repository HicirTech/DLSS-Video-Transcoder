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
import { NvencEncoder, type NvencCodec } from "../nvenc.ts";

interface OpenMsg {
  type: "open";
  ffmpeg: string;
  sinkArgs: string[];
  enc: { width: number; height: number; fpsNum: number; fpsDen: number; codec: NvencCodec; preset?: "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7"; cq?: number; ordinal?: number };
}
interface FrameMsg { type: "frame"; index: number; buf: ArrayBuffer }
interface FinishMsg { type: "finish" }
type InMsg = OpenMsg | FrameMsg | FinishMsg;

declare const self: Worker;

let encoder: NvencEncoder | null = null;
let sink: ReturnType<typeof Bun.spawn> | null = null;
let chain: Promise<void> = Promise.resolve();
let failed = false;

function fail(message: string): void {
  if (failed) return;
  failed = true;
  self.postMessage({ type: "error", message });
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
      if (failed || !encoder || !sink) return;
      const pkt = encoder.encode(new Uint8Array(msg.buf));
      const wrote = (sink.stdin as { write(b: Uint8Array): unknown }).write(pkt);
      if (wrote instanceof Promise) await wrote;
      self.postMessage({ type: "encoded", index: msg.index });
    }).catch((error) => fail((error as Error).message ?? String(error)));
  } else if (msg.type === "finish") {
    chain = chain.then(async () => {
      if (failed || !encoder || !sink) return;
      encoder.finish();
      (sink.stdin as { end(): unknown }).end();
      const err = (await new Response(sink.stderr as ReadableStream<Uint8Array>).text()).trim();
      const code = await sink.exited;
      encoder.close();
      encoder = null;
      if (code !== 0) { fail(`ffmpeg mux failed (${code}): ${err}`); return; }
      self.postMessage({ type: "done" });
    }).catch((error) => fail((error as Error).message ?? String(error)));
  }
};
