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
 * in flight (decode->main->encode) and so memory use to ~CREDIT_WINDOW frames.
 */
import { throwIfAborted } from "./cancel.ts";
import type { Engine } from "./engine.ts";
import { connectFrameFlow, type FrameCounts } from "./frame-flow.ts";
import type { ProgressReporter } from "./frame-progress.ts";
import { WorkerPairRun } from "./worker-pair-run.ts";
import type { EncodeFrame, EncodeOpen } from "./workers/encode-worker.ts";

/** Max frames in flight across the whole pipeline: the decode worker's initial credit. */
const CREDIT_WINDOW = 8;

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
  enc: EncodeOpen["enc"];
  totalFrames: number | null;
  /** Per-frame guide computed on the main thread (scene cut / motion). */
  guide: (rgba: Uint8Array, frameIndex: number) => { reset: boolean; motion: Float32Array | null; sceneCut: boolean };
  onProgress?: ProgressReporter;
  /** Cooperative cancellation: until the encode is finishing, the run stops at the next frame and rejects with JobCancelledError. */
  signal?: AbortSignal;
  /** Called once as the run starts finishing; see VideoJobOptions.onFinishing. */
  onFinishing?: () => void;
  /** Where the decode and encode workers run; tests hand in stand-ins. */
  createWorker?: (script: URL) => Worker;
}

export function runThreadedEncode(p: ThreadedEncodeParams): Promise<FrameCounts> {
  throwIfAborted(p.signal);
  const progress = p.onProgress ?? (() => {});
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

    // The engine belongs to the caller; the workers are all this run owns.
    const run = new WorkerPairRun<FrameCounts>({
      decodeWorker: decodeW, encodeWorker: encodeW, signal: p.signal, onFinishing: p.onFinishing, resolve, reject,
    });
    connectFrameFlow(run, {
      decodeWorker: decodeW,
      encodeWorker: encodeW,
      decodeStart: { ffmpeg: p.ffmpeg, args: p.decodeArgs, frameBytes: p.frameBytes },
      creditWindow: CREDIT_WINDOW,
      totalFrames: p.totalFrames,
      onProgress: progress,
      processFrame: (decoded, frameNumber) => {
        const rgba = new Uint8Array(decoded.buf);
        const g = p.guide(rgba, frameNumber);
        const result = p.engine.process({ rgba, reset: g.reset, motion: g.motion });
        const out = result.buffer as ArrayBuffer;
        const frame: EncodeFrame = { type: "frame", index: decoded.index, buf: out };
        encodeW.postMessage(frame, [out]);
        return g.sceneCut;
      },
    });

    // Bring the encoder + mux up first; decoding starts on "opened".
    const open: EncodeOpen = { type: "open", ffmpeg: p.ffmpeg, sinkArgs: p.sinkArgs, enc: p.enc };
    encodeW.postMessage(open);
  });
}
