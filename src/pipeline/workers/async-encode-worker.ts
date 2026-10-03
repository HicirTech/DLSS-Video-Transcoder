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
import { NvencEncoder, type NvencSdkCodec } from "../nvenc.ts";
import { type AbortRequest, answerAbort } from "../worker-abort.ts";
import { importD3D12Buffer, importD3D12Fence, waitExternalSemaphore, destroyExternalMemory, destroyExternalSemaphore } from "../../native/cuda-interop.ts";
import { cudaCreateContext, cudaSynchronize } from "../../native/cuda.ts";
import { closeHandle } from "../../native/win32.ts";

interface OpenMsg {
  type: "open";
  ffmpeg: string; sinkArgs: string[];
  bufHandles: number[]; fenceHandle: number; size: number;
  width: number; height: number; pitch: number; fpsNum: number; fpsDen: number; codec: NvencSdkCodec; cq: number; ordinal: number;
}
type InMsg = OpenMsg | { type: "frame"; slot: number; value: bigint } | { type: "finish" } | AbortRequest;

declare const self: Worker;
let enc: NvencEncoder | null = null;
let sink: ReturnType<typeof Bun.spawn> | null = null;
let extSem = 0n;
let extMems: bigint[] = [];
let chain: Promise<void> = Promise.resolve();
/** No more work: set by a failure or an abort. */
let stopped = false;

const fail = (message: string): void => { if (!stopped) { stopped = true; self.postMessage({ type: "error", message }); } };

/**
 * Close NVENC, then the CUDA imports its inputs alias. Both finish and abort
 * reach this, in either order (an abort follows a finish whose mux failed), so
 * a second call must find nothing left to destroy.
 */
function releaseEncoder(): void {
  try {
    enc?.close();
  } finally {
    enc = null;
    for (const extMem of extMems) { try { destroyExternalMemory(extMem); } catch { /* keep releasing the rest */ } }
    extMems = [];
    if (extSem !== 0n) { try { destroyExternalSemaphore(extSem); } catch { /* */ } }
    extSem = 0n;
  }
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const m = e.data;
  if (m.type === "open") {
    try {
      cudaCreateContext(m.ordinal);
      const inputs = m.bufHandles.map((h) => {
        const { extMem, devPtr } = importD3D12Buffer(h, m.size);
        extMems.push(extMem);
        return { devPtr, pitch: m.pitch };
      });
      extSem = importD3D12Fence(m.fenceHandle);
      enc = NvencEncoder.open({ width: m.width, height: m.height, fpsNum: m.fpsNum, fpsDen: m.fpsDen, codec: m.codec, cq: m.cq, ordinal: m.ordinal, inputs });
      sink = Bun.spawn([m.ffmpeg, ...m.sinkArgs], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
      self.postMessage({ type: "opened" });
    } catch (err) {
      fail((err as Error).message ?? String(err));
    } finally {
      // Importing does not take ownership of an NT handle (see cuda-interop.ts),
      // so every handle is closed here, imported or not: one left open after a
      // failed import keeps its D3D12 allocation alive.
      for (const h of m.bufHandles) closeHandle(h);
      closeHandle(m.fenceHandle);
    }
  } else if (m.type === "frame") {
    chain = chain.then(async () => {
      if (stopped || !enc || !sink) return;
      waitExternalSemaphore(extSem, m.value); // enqueue "wait fence >= value" on the CUDA stream
      cudaSynchronize(); // block this worker until the DLSS copy for this frame is done
      const pkt = enc.encodeGpuResident(m.slot);
      const w = (sink.stdin as { write(b: Uint8Array): unknown }).write(pkt);
      if (w instanceof Promise) await w;
      self.postMessage({ type: "encoded", slot: m.slot });
    }).catch((err) => fail((err as Error).message ?? String(err)));
  } else if (m.type === "abort") {
    // Immediate, not chained: queued frames are dropped; the encoder's own
    // CUDA work is finished by close(), so the shared buffers can be released.
    stopped = true;
    void answerAbort(self, sink, releaseEncoder);
  } else if (m.type === "finish") {
    chain = chain.then(async () => {
      if (stopped || !enc || !sink) return;
      enc.finish();
      (sink.stdin as { end(): unknown }).end();
      const err = (await new Response(sink.stderr as ReadableStream<Uint8Array>).text()).trim();
      const code = await sink.exited;
      releaseEncoder();
      if (code !== 0) { fail(`ffmpeg mux failed (${code}): ${err}`); return; }
      self.postMessage({ type: "done" });
    }).catch((err) => fail((err as Error).message ?? String(err)));
  }
};
