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
import { NvencEncoder, type NvencCodec } from "../nvenc.ts";
import { importD3D12Buffer, importD3D12Fence, waitExternalSemaphore, destroyExternalMemory, destroyExternalSemaphore, closeHandle } from "../../native/cuda-interop.ts";
import { cudaCreateContext, cudaSynchronize } from "../../native/cuda.ts";

interface OpenMsg {
  type: "open";
  ffmpeg: string; sinkArgs: string[];
  bufHandles: number[]; fenceHandle: number; size: number;
  width: number; height: number; pitch: number; fpsNum: number; fpsDen: number; codec: NvencCodec; cq: number; ordinal: number;
}
type InMsg = OpenMsg | { type: "frame"; slot: number; value: bigint } | { type: "finish" };

declare const self: Worker;
let enc: NvencEncoder | null = null;
let sink: ReturnType<typeof Bun.spawn> | null = null;
let extSem = 0n;
let extMems: bigint[] = [];
let chain: Promise<void> = Promise.resolve();
let failed = false;

const fail = (message: string): void => { if (!failed) { failed = true; self.postMessage({ type: "error", message }); } };

self.onmessage = (e: MessageEvent<InMsg>) => {
  const m = e.data;
  if (m.type === "open") {
    try {
      cudaCreateContext(m.ordinal);
      const inputs = m.bufHandles.map((h) => {
        const { extMem, devPtr } = importD3D12Buffer(h, m.size);
        closeHandle(h);
        extMems.push(extMem);
        return { devPtr, pitch: m.pitch };
      });
      extSem = importD3D12Fence(m.fenceHandle);
      closeHandle(m.fenceHandle);
      enc = NvencEncoder.open({ width: m.width, height: m.height, fpsNum: m.fpsNum, fpsDen: m.fpsDen, codec: m.codec, preset: "p5", cq: m.cq, inputs });
      sink = Bun.spawn([m.ffmpeg, ...m.sinkArgs], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
      self.postMessage({ type: "opened" });
    } catch (err) { fail((err as Error).message ?? String(err)); }
  } else if (m.type === "frame") {
    chain = chain.then(async () => {
      if (failed || !enc || !sink) return;
      waitExternalSemaphore(extSem, m.value); // enqueue "wait fence >= value" on the CUDA stream
      cudaSynchronize(); // block this worker until the DLSS copy for this frame is done
      const pkt = enc.encodeGpuResident(m.slot);
      const w = (sink.stdin as { write(b: Uint8Array): unknown }).write(pkt);
      if (w instanceof Promise) await w;
      self.postMessage({ type: "encoded", slot: m.slot });
    }).catch((err) => fail((err as Error).message ?? String(err)));
  } else if (m.type === "finish") {
    chain = chain.then(async () => {
      if (failed || !enc || !sink) return;
      enc.finish();
      (sink.stdin as { end(): unknown }).end();
      const err = (await new Response(sink.stderr as ReadableStream<Uint8Array>).text()).trim();
      const code = await sink.exited;
      enc.close();
      for (const em of extMems) { try { destroyExternalMemory(em); } catch { /* */ } }
      try { destroyExternalSemaphore(extSem); } catch { /* */ }
      enc = null;
      if (code !== 0) { fail(`ffmpeg mux failed (${code}): ${err}`); return; }
      self.postMessage({ type: "done" });
    }).catch((err) => fail((err as Error).message ?? String(err)));
  }
};
