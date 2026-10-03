/**
 * GPU-resident async pipeline for DLSS Neural Rendering + NVENC: a decode
 * worker, DLSS on the main thread and an encode worker, with no CPU copy of a
 * frame between DLSS and NVENC.
 *
 * The main thread records DLSS eval plus a copy of the result into a shared
 * D3D12 buffer slot, submits it without waiting and signals a shared fence; the
 * encode worker imports pool and fence into CUDA, waits that fence value and
 * encodes the slot straight from GPU memory. DLSS runs on D3D12 compute and
 * NVENC on the separate encoder units, so frame i+1's DLSS overlaps frame i's
 * encode. A slot only becomes free again when the encode worker acks it, which
 * bounds memory to POOL_SLOTS frames.
 */
import { AsyncSubmit } from "../native/async-submit.ts";
import { D3D12_HEAP_TYPE_UPLOAD, type D3D12Fence, type D3D12Resource } from "../native/d3d12.ts";
import { closeHandle } from "../native/win32.ts";
import type { DlssNrSession } from "../ngx/nr-render.ts";
import { throwIfAborted } from "./cancel.ts";
import { connectFrameFlow, type FrameCounts } from "./frame-flow.ts";
import type { ProgressReporter } from "./frame-progress.ts";
import type { GpuSession } from "./gpu.ts";
import { WorkerPairRun } from "./worker-pair-run.ts";
import type { AsyncEncodeFrame, AsyncEncodeOpen, AsyncEncodeOut } from "./workers/async-encode-worker.ts";

/** Shared buffer slots, and so the most frames in flight between DLSS and NVENC. */
const POOL_SLOTS = 4;

export interface AsyncNrEncodeParams {
  session: GpuSession;
  nr: DlssNrSession;
  ffmpeg: string;
  decodeArgs: string[]; // ffmpeg decode argv (emits rawvideo rgba on pipe:1)
  sinkArgs: string[]; // ffmpeg mux argv (reads the elementary stream on pipe:0)
  width: number;
  height: number;
  rowPitch: number; // row pitch of the shared buffers: >= width*4, aligned to D3D12_TEXTURE_DATA_PITCH_ALIGNMENT (256)
  totalBytes: number; // size of each shared buffer
  enc: Pick<AsyncEncodeOpen, "fpsNum" | "fpsDen" | "codec" | "cq" | "ordinal">;
  totalFrames: number | null;
  /** Per-frame guide (main thread), NR takes no motion. */
  guide: (rgba: Uint8Array, index: number) => { reset: boolean; sceneCut: boolean };
  onProgress?: ProgressReporter;
  /** Cooperative cancellation: until the encode is finishing, the run stops at the next frame and rejects with JobCancelledError. */
  signal?: AbortSignal;
  /** Called once as the run starts finishing; see VideoJobOptions.onFinishing. */
  onFinishing?: () => void;
}

/**
 * One run's shared slots: a DEFAULT-heap buffer per slot that DLSS writes and
 * NVENC reads, an UPLOAD staging buffer per slot, the fence that orders the two
 * engines, and the NT handles through which the encode worker imports buffers
 * and fence into CUDA.
 */
interface SharedPool {
  buffers: D3D12Resource[];
  stagings: D3D12Resource[];
  bufferHandles: number[];
  fence: D3D12Fence;
  fenceHandle: number;
  submit: AsyncSubmit;
}

function createSharedPool(session: GpuSession, slots: number, bytesPerSlot: number): SharedPool {
  const { device, gpu } = session;
  const buffers: D3D12Resource[] = [];
  const stagings: D3D12Resource[] = [];
  const bufferHandles: number[] = [];
  let fence: D3D12Fence | null = null;
  let fenceHandle: number | null = null;
  try {
    for (let i = 0; i < slots; i++) {
      const buffer = device.createSharedBuffer(bytesPerSlot, `nr-shared ${i}`);
      buffers.push(buffer);
      bufferHandles.push(device.createSharedHandle(buffer));
      stagings.push(device.createBuffer(bytesPerSlot, D3D12_HEAP_TYPE_UPLOAD, `nr-staging ${i}`));
    }
    fence = device.createSharedFence(0n);
    fenceHandle = device.createSharedHandle(fence);
    const submit = new AsyncSubmit(device, gpu.queue, fence, slots);
    return { buffers, stagings, bufferHandles, fence, fenceHandle, submit };
  } catch (error) {
    // Nothing owns a partly built pool yet, so it is undone here.
    closeSharedHandles(bufferHandles, fenceHandle);
    for (const resource of [...buffers, ...stagings, ...(fence ? [fence] : [])]) resource.release();
    throw error;
  }
}

/** The pool's NT handles, closed here only while the encode worker has not taken them over (its "open" handler closes them). */
function closeSharedHandles(bufferHandles: readonly number[], fenceHandle: number | null): void {
  for (const handle of bufferHandles) closeHandle(handle);
  if (fenceHandle !== null) closeHandle(fenceHandle);
}

/** Each step on its own, so one failure cannot strand the objects after it. */
function releaseSharedPool(pool: SharedPool): void {
  try { pool.submit.drain(); } catch { /* the queue may have faulted; release regardless */ }
  try { pool.submit.close(); } catch { /* */ }
  for (const resource of [...pool.buffers, ...pool.stagings, pool.fence]) {
    try { resource.release(); } catch { /* */ }
  }
}

/** Both workers, or neither: a failure to start the second terminates the first. */
function startWorkers(): { encodeWorker: Worker; decodeWorker: Worker } {
  const encodeWorker = new Worker(new URL("./workers/async-encode-worker.ts", import.meta.url).href);
  try {
    return { encodeWorker, decodeWorker: new Worker(new URL("./workers/decode-worker.ts", import.meta.url).href) };
  } catch (error) {
    encodeWorker.terminate();
    throw error;
  }
}

export function runAsyncNrEncode(p: AsyncNrEncodeParams): Promise<FrameCounts> {
  // Before anything below is allocated or spawned.
  throwIfAborted(p.signal);
  const progress = p.onProgress ?? (() => {});
  const frameBytes = p.width * p.height * 4;

  const pool = createSharedPool(p.session, POOL_SLOTS, p.totalBytes);
  let workers: { encodeWorker: Worker; decodeWorker: Worker };
  try {
    workers = startWorkers();
  } catch (error) {
    closeSharedHandles(pool.bufferHandles, pool.fenceHandle);
    releaseSharedPool(pool);
    throw error;
  }
  const { encodeWorker, decodeWorker } = workers;

  return new Promise((resolve, reject) => {
    const freeSlots: number[] = [];
    for (let i = 0; i < POOL_SLOTS; i++) freeSlots.push(i);
    // Any reply from the encode worker means it handled "open", which closes
    // the NT handles; one that died before that leaves them to this side.
    let handlesClosedByWorker = false;

    // The pool goes only after the encode worker has closed NVENC and dropped
    // its CUDA imports of it, whichever way the run ends.
    const run = new WorkerPairRun<FrameCounts>({
      decodeWorker, encodeWorker, signal: p.signal, onFinishing: p.onFinishing, resolve, reject,
      release: () => {
        if (!handlesClosedByWorker) closeSharedHandles(pool.bufferHandles, pool.fenceHandle);
        releaseSharedPool(pool);
      },
    });
    connectFrameFlow<Extract<AsyncEncodeOut, { type: "encoded" }>>(run, {
      decodeWorker,
      encodeWorker,
      decodeStart: { ffmpeg: p.ffmpeg, args: p.decodeArgs, frameBytes },
      creditWindow: POOL_SLOTS,
      totalFrames: p.totalFrames,
      onProgress: progress,
      processFrame: (decoded, frameNumber) => {
        const rgba = new Uint8Array(decoded.buf);
        const g = p.guide(rgba, frameNumber);
        const slot = freeSlots.shift()!;
        const list = pool.submit.begin(slot);
        p.nr.recordEvaluateInto(list, pool.stagings[slot]!, rgba, g.reset, pool.buffers[slot]!, p.rowPitch);
        const value = pool.submit.submit(slot);
        const frame: AsyncEncodeFrame = { type: "frame", slot, value };
        encodeWorker.postMessage(frame);
        return g.sceneCut;
      },
      onEncodeReply: () => { handlesClosedByWorker = true; },
      onEncoded: (ack) => { freeSlots.push(ack.slot); },
    });

    const open: AsyncEncodeOpen = {
      type: "open", ffmpeg: p.ffmpeg, sinkArgs: p.sinkArgs,
      bufHandles: pool.bufferHandles, fenceHandle: pool.fenceHandle, size: p.totalBytes,
      width: p.width, height: p.height, pitch: p.rowPitch,
      fpsNum: p.enc.fpsNum, fpsDen: p.enc.fpsDen, codec: p.enc.codec, cq: p.enc.cq, ordinal: p.enc.ordinal,
    };
    encodeWorker.postMessage(open);
  });
}
