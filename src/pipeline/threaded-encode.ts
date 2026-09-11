/**
 * Threaded video encode pipeline: an ffmpeg decode worker, `engine.process` on
 * the main thread and a CUDA/NVENC encode worker, with frames moving between
 * them as transferred ArrayBuffers.
 *
 * The stages need separate threads because the synchronous FFI calls (DLSS eval,
 * NVENC encode) never yield: on one thread the decode pipe cannot drain and the
 * encoder cannot run while DLSS is working, so wall time is the sum of the three
 * stages instead of the slowest one. The engine stays on the main thread because
 * D3D12/NGX objects may only be used from the thread that created them.
 *
 * One decode and one encode worker, both FIFO, keep frames in display order,
 * which is what NVENC's no-B-frame config expects. A credit window bounds frames
 * in flight (decode->main->encode) and so memory use to ~`window` frames.
 */
import type { Engine } from "./engine.ts";

export interface ThreadedEncodeParams {
  engine: Engine;
  ffmpeg: string;
  /** ffmpeg decode argv after the binary; must emit rawvideo rgba on pipe:1. */
  decodeArgs: string[];
  /** Engine-input frame size in bytes (renderWidth*renderHeight*4). */
  frameBytes: number;
  /** ffmpeg mux argv after the binary; must read the elementary stream on pipe:0. */
  sinkArgs: string[];
  /** NVENC settings; `ordinal` is the renderer's CUDA device (GpuSession.cudaOrdinal), so encode and render share one GPU. */
  enc: {
    width: number; height: number; fpsNum: number; fpsDen: number;
    codec: "h264" | "hevc"; preset?: "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7"; cq?: number; ordinal: number;
  };
  totalFrames: number | null;
  /** Per-frame guide computed on the main thread (scene cut / motion). */
  guide: (rgba: Uint8Array, frameIndex: number) => { reset: boolean; motion: Float32Array | null; sceneCut: boolean };
  onProgress?: (fraction: number, message: string, frames?: number) => void;
  /** Max frames in flight across the whole pipeline (default 8). */
  window?: number;
}

export function runThreadedEncode(p: ThreadedEncodeParams): Promise<{ frames: number; sceneCuts: number }> {
  const progress = p.onProgress ?? (() => {});
  const window = p.window ?? 8;
  return new Promise((resolve, reject) => {
    const decodeW = new Worker(new URL("./workers/decode-worker.ts", import.meta.url).href);
    const encodeW = new Worker(new URL("./workers/encode-worker.ts", import.meta.url).href);

    let sent = 0; // frames handed to the encode worker
    let acked = 0; // frames the encode worker has finished
    let frames = 0; // frames processed by the engine
    let sceneCuts = 0;
    let decodeEnded = false;
    let finishSent = false;
    let settled = false;

    const cleanup = (): void => { try { decodeW.terminate(); } catch { /* */ } try { encodeW.terminate(); } catch { /* */ } };
    const fail = (message: string): void => { if (settled) return; settled = true; cleanup(); reject(new Error(message)); };
    const finishIfDone = (): void => {
      if (!settled && !finishSent && decodeEnded && acked === sent) {
        finishSent = true;
        encodeW.postMessage({ type: "finish" });
      }
    };

    decodeW.addEventListener("error", (e) => fail(`decode worker crashed: ${(e as ErrorEvent).message}`));
    encodeW.addEventListener("error", (e) => fail(`encode worker crashed: ${(e as ErrorEvent).message}`));

    encodeW.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; message?: string };
      if (msg.type === "opened") {
        decodeW.postMessage({ type: "start", ffmpeg: p.ffmpeg, args: p.decodeArgs, frameBytes: p.frameBytes });
        decodeW.postMessage({ type: "credit", n: window });
      } else if (msg.type === "encoded") {
        acked++;
        if (!decodeEnded) decodeW.postMessage({ type: "credit", n: 1 });
        const total = p.totalFrames;
        progress(total ? Math.min(0.98, acked / total) : 0.5, `frame ${acked}/${total ?? "?"}`, acked);
        finishIfDone();
      } else if (msg.type === "done") {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ frames, sceneCuts });
      } else if (msg.type === "error") {
        fail(`encode: ${msg.message}`);
      }
    };

    decodeW.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; index?: number; buf?: ArrayBuffer; frames?: number; message?: string };
      if (msg.type === "frame") {
        if (settled) return;
        try {
          const rgba = new Uint8Array(msg.buf!);
          const g = p.guide(rgba, frames);
          if (g.sceneCut) sceneCuts++;
          const result = p.engine.process({ rgba, reset: g.reset, motion: g.motion });
          frames++;
          const out = result.buffer as ArrayBuffer;
          encodeW.postMessage({ type: "frame", index: msg.index, buf: out }, [out]);
          sent++;
        } catch (error) {
          fail(`engine: ${(error as Error).message}`);
        }
      } else if (msg.type === "end") {
        decodeEnded = true;
        finishIfDone();
      } else if (msg.type === "error") {
        fail(`decode: ${msg.message}`);
      }
    };

    // Bring the encoder + mux up first; decoding starts on "opened".
    encodeW.postMessage({ type: "open", ffmpeg: p.ffmpeg, sinkArgs: p.sinkArgs, enc: p.enc });
  });
}
