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
import { throwIfAborted } from "./cancel.ts";
import type { Engine } from "./engine.ts";
import { WorkerPairRun } from "./worker-pair-run.ts";

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
  /** Cooperative cancellation: until the encode is finishing, the run stops at the next frame and rejects with JobCancelledError. */
  signal?: AbortSignal;
  /** Called once as the run starts finishing; see VideoJobOptions.onFinishing. */
  onFinishing?: () => void;
  /** Where the decode and encode workers run; tests hand in stand-ins. */
  createWorker?: (script: URL) => Worker;
}

export function runThreadedEncode(p: ThreadedEncodeParams): Promise<{ frames: number; sceneCuts: number }> {
  throwIfAborted(p.signal);
  const progress = p.onProgress ?? (() => {});
  const window = p.window ?? 8;
  const createWorker = p.createWorker ?? ((script: URL) => new Worker(script.href));
  return new Promise((resolve, reject) => {
    const decodeW = createWorker(new URL("./workers/decode-worker.ts", import.meta.url));
    let encodeW: Worker;
    try {
      encodeW = createWorker(new URL("./workers/encode-worker.ts", import.meta.url));
    } catch (error) {
      decodeW.terminate(); // both workers or neither
      throw error;
    }

    let sent = 0; // frames handed to the encode worker
    let frames = 0; // frames processed by the engine
    let sceneCuts = 0;
    let decodeEnded = false;

    // The engine belongs to the caller; the workers are all this run owns.
    const run = new WorkerPairRun<{ frames: number; sceneCuts: number }>({
      decodeWorker: decodeW, encodeWorker: encodeW, signal: p.signal, onFinishing: p.onFinishing, resolve, reject,
    });
    const finishIfDone = (): void => {
      if (run.running && decodeEnded && run.framesWritten === sent) run.finish();
    };

    encodeW.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; message?: string };
      if (msg.type === "encoded") run.recordEncoded();
      // After a stop the encoder may still answer "opened" or "encoded": neither may start the decoder or report progress.
      if (!run.active) return;
      if (msg.type === "opened") {
        decodeW.postMessage({ type: "start", ffmpeg: p.ffmpeg, args: p.decodeArgs, frameBytes: p.frameBytes });
        decodeW.postMessage({ type: "credit", n: window });
      } else if (msg.type === "encoded") {
        if (!decodeEnded) decodeW.postMessage({ type: "credit", n: 1 });
        const total = p.totalFrames;
        const written = run.framesWritten;
        progress(total ? Math.min(0.98, written / total) : 0.5, `frame ${written}/${total ?? "?"}`, written);
        finishIfDone();
      } else if (msg.type === "done") {
        run.succeed({ frames, sceneCuts });
      } else if (msg.type === "error") {
        run.fail(`encode: ${msg.message}`);
      }
    };

    decodeW.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; index?: number; buf?: ArrayBuffer; frames?: number; message?: string };
      if (!run.active) return;
      if (msg.type === "frame") {
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
          run.fail(`engine: ${(error as Error).message}`);
        }
      } else if (msg.type === "end") {
        decodeEnded = true;
        finishIfDone();
      } else if (msg.type === "error") {
        run.fail(`decode: ${msg.message}`);
      }
    };

    // Bring the encoder + mux up first; decoding starts on "opened".
    encodeW.postMessage({ type: "open", ffmpeg: p.ffmpeg, sinkArgs: p.sinkArgs, enc: p.enc });
  });
}
