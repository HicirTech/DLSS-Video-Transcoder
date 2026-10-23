/**
 * Async zero-copy encode worker for the GPU-resident NR pipeline.
 *
 * Imports the main thread's D3D12 shared-buffer pool and shared fence (by their
 * Win32 handles) into CUDA — the buffers as external memory (one NVENC input per
 * pool slot), the fence as an external semaphore. For each frame it waits the
 * fence value the main thread signalled after the DLSS copy, then encodes that
 * pool slot straight from GPU memory (no upload) and pipes the compressed bytes
 * to the mux ffmpeg. The CPU wait is on THIS thread, so the DLSS thread never
 * blocks and DLSS frame i+1 overlaps NVENC frame i on the GPU.
 */
import { ffmpegFailedMessage } from "../ffmpeg-failure.ts";
import { MuxSink } from "../mux-sink.ts";
import { NvencEncoder, type NvencEncoderOptions } from "../nvenc.ts";
import { type AbortedReply, type AbortRequest, answerAbort } from "../worker-abort.ts";
import { importD3D12Buffer, importD3D12Fence, waitExternalSemaphore, releaseD3D12Buffer, destroyExternalSemaphore, type ImportedBuffer } from "../../native/cuda-interop.ts";
import { cudaCreateContext, cudaSynchronize } from "../../native/cuda.ts";
import { closeHandle } from "../../native/win32.ts";

/**
 * Import the main thread's shared buffers (one NT handle per pool slot, all closed here) and fence
 * into CUDA, open NVENC on them and the mux ffmpeg whose `sinkArgs` read the stream on pipe:0.
 */
export interface AsyncEncodeOpen {
  type: "open";
  ffmpeg: string;
  sinkArgs: string[];
  /** NT handles of the shared D3D12 buffers, one per pool slot; the worker closes every one. */
  bufferHandles: number[];
  /** NT handle of the shared D3D12 fence; the worker closes it. */
  fenceHandle: number;
  /** Byte size of EACH shared buffer (every slot is the same size), as imported by cuImportExternalMemory. */
  bufferBytes: number;
  /** Bytes per row of each shared buffer: >= width*4, aligned to D3D12_TEXTURE_DATA_PITCH_ALIGNMENT (256). */
  rowPitch: number;
  /** NVENC's settings; its inputs are the imported buffers. */
  enc: Omit<NvencEncoderOptions, "inputs">;
}
/** Encode pool slot `slot` once the fence reaches `value`, then ack the slot as free. */
export interface AsyncEncodeFrame { type: "frame"; slot: number; value: bigint }
/** What the main thread sends the async encode worker. */
type AsyncEncodeIn = AsyncEncodeOpen | AsyncEncodeFrame | { type: "finish" } | AbortRequest;
/** What it answers. */
export type AsyncEncodeOut =
  | { type: "opened" }
  | { type: "encoded"; slot: number }
  | { type: "done" }
  | { type: "error"; message: string }
  | AbortedReply;

declare const self: Worker;

const post = (message: AsyncEncodeOut): void => self.postMessage(message);
let encoder: NvencEncoder | null = null;
let sink: MuxSink | null = null;
let extSem = 0n;
let imported: ImportedBuffer[] = [];
let chain: Promise<void> = Promise.resolve();
/** No more work: set by a failure or an abort. */
let stopped = false;

const fail = (message: string): void => { if (!stopped) { stopped = true; post({ type: "error", message }); } };

/**
 * Close NVENC, then the CUDA imports its inputs alias. Both finish and abort
 * reach this, in either order (an abort follows a finish whose mux failed), so
 * a second call must find nothing left to destroy.
 */
function releaseEncoder(): void {
  try {
    encoder?.close();
  } finally {
    encoder = null;
    for (const buffer of imported) { try { releaseD3D12Buffer(buffer); } catch { /* keep releasing the rest */ } }
    imported = [];
    if (extSem !== 0n) { try { destroyExternalSemaphore(extSem); } catch { /* */ } }
    extSem = 0n;
  }
}

self.onmessage = (event: MessageEvent<AsyncEncodeIn>) => {
  const message = event.data;
  if (message.type === "open") {
    try {
      cudaCreateContext(message.enc.ordinal);
      const inputs = message.bufferHandles.map((handle) => {
        const buffer = importD3D12Buffer(handle, message.bufferBytes);
        imported.push(buffer);
        return { devPtr: buffer.devPtr, pitch: message.rowPitch };
      });
      extSem = importD3D12Fence(message.fenceHandle);
      encoder = NvencEncoder.open({ ...message.enc, inputs });
      sink = MuxSink.spawn(message.ffmpeg, message.sinkArgs);
      post({ type: "opened" });
    } catch (err) {
      fail((err as Error).message ?? String(err));
    } finally {
      // Importing does not take ownership of an NT handle (see cuda-interop.ts),
      // so every handle is closed here, imported or not: one left open after a
      // failed import keeps its D3D12 allocation alive.
      for (const handle of message.bufferHandles) closeHandle(handle);
      closeHandle(message.fenceHandle);
    }
  } else if (message.type === "frame") {
    chain = chain.then(async () => {
      if (stopped || !encoder || !sink) return;
      waitExternalSemaphore(extSem, message.value); // enqueue "wait fence >= value" on the CUDA stream
      cudaSynchronize(); // block this worker until the DLSS copy for this frame is done
      const packet = encoder.encodeGpuResident(message.slot);
      await sink.write(packet);
      post({ type: "encoded", slot: message.slot });
    }).catch(async (err) => fail(sink ? await sink.failureOf(err) : (err as Error).message ?? String(err)));
  } else if (message.type === "abort") {
    // Immediate, not chained: queued frames are dropped; the encoder's own
    // CUDA work is finished by close(), so the shared buffers can be released.
    stopped = true;
    void answerAbort(self, sink?.child ?? null, releaseEncoder);
  } else if (message.type === "finish") {
    chain = chain.then(async () => {
      if (stopped || !encoder || !sink) return;
      encoder.finish();
      const { code, stderr } = await sink.close();
      releaseEncoder();
      if (code !== 0) { fail(ffmpegFailedMessage("mux", code, stderr)); return; }
      post({ type: "done" });
    }).catch((err) => fail((err as Error).message ?? String(err)));
  }
};
