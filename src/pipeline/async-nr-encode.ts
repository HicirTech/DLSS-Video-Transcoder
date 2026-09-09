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
 * bounds memory to `poolSize` frames.
 */
import { AsyncSubmit } from "../native/async-submit.ts";
import { D3D12_HEAP_TYPE_UPLOAD, type D3D12Resource } from "../native/d3d12.ts";
import type { DlssNrSession } from "../ngx/nr-render.ts";
import type { GpuSession } from "./gpu.ts";
import type { NvencCodec } from "./nvenc.ts";

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
  enc: { fpsNum: number; fpsDen: number; codec: NvencCodec; cq: number; ordinal: number };
  totalFrames: number | null;
  /** Per-frame guide (main thread), NR takes no motion. */
  guide: (rgba: Uint8Array, index: number) => { reset: boolean; sceneCut: boolean };
  onProgress?: (fraction: number, message: string, frames?: number) => void;
  poolSize?: number;
}

export function runAsyncNrEncode(p: AsyncNrEncodeParams): Promise<{ frames: number; sceneCuts: number }> {
  const progress = p.onProgress ?? (() => {});
  const K = p.poolSize ?? 4;
  const { device, gpu } = p.session;
  const frameBytes = p.width * p.height * 4;

  // Buffers and fence are created shared, and their Win32 handles sent to the
  // encode worker, so CUDA can import the same allocations the queue writes.
  // Everything allocated here is owned here and released in cleanup().
  const buffers: D3D12Resource[] = [];
  const stagings: D3D12Resource[] = [];
  const bufHandles: number[] = [];
  for (let i = 0; i < K; i++) {
    const b = device.createSharedBuffer(p.totalBytes, `nr-shared ${i}`);
    buffers.push(b);
    bufHandles.push(device.createSharedHandle(b));
    stagings.push(device.createBuffer(p.totalBytes, D3D12_HEAP_TYPE_UPLOAD, `nr-staging ${i}`));
  }
  const sharedFence = device.createSharedFence(0n);
  const fenceHandle = device.createSharedHandle(sharedFence);
  const submit = new AsyncSubmit(device, gpu.queue, sharedFence, K);

  return new Promise((resolve, reject) => {
    const encW = new Worker(new URL("./workers/async-encode-worker.ts", import.meta.url).href);
    const decW = new Worker(new URL("./workers/decode-worker.ts", import.meta.url).href);

    const freeSlots: number[] = []; for (let i = 0; i < K; i++) freeSlots.push(i);
    let frames = 0, acked = 0, sceneCuts = 0, decodeEnded = false, settled = false;

    const cleanup = (): void => {
      try { decW.terminate(); } catch { /* */ }
      try { encW.terminate(); } catch { /* */ }
      try { submit.drain(); } catch { /* */ }
      submit.close();
      for (const b of buffers) b.release();
      for (const s of stagings) s.release();
      sharedFence.release();
    };
    const fail = (message: string): void => { if (settled) return; settled = true; cleanup(); reject(new Error(message)); };
    const maybeFinish = (): void => { if (!settled && decodeEnded && acked === frames) encW.postMessage({ type: "finish" }); };

    decW.addEventListener("error", (e) => fail(`decode worker crashed: ${(e as ErrorEvent).message}`));
    encW.addEventListener("error", (e) => fail(`encode worker crashed: ${(e as ErrorEvent).message}`));

    encW.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; slot?: number; message?: string };
      if (m.type === "opened") {
        decW.postMessage({ type: "start", ffmpeg: p.ffmpeg, args: p.decodeArgs, frameBytes });
        decW.postMessage({ type: "credit", n: K });
      } else if (m.type === "encoded") {
        acked++;
        freeSlots.push(m.slot!);
        if (!decodeEnded) decW.postMessage({ type: "credit", n: 1 });
        const total = p.totalFrames;
        progress(total ? Math.min(0.98, acked / total) : 0.5, `frame ${acked}/${total ?? "?"}`, acked);
        maybeFinish();
      } else if (m.type === "done") {
        if (settled) return;
        settled = true; cleanup(); resolve({ frames, sceneCuts });
      } else if (m.type === "error") {
        fail(`encode: ${m.message}`);
      }
    };

    decW.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; buf?: ArrayBuffer; message?: string };
      if (m.type === "frame") {
        if (settled) return;
        try {
          const rgba = new Uint8Array(m.buf!);
          const g = p.guide(rgba, frames);
          if (g.sceneCut) sceneCuts++;
          const slot = freeSlots.shift()!;
          const list = submit.begin(slot);
          p.nr.recordEvaluateInto(list, stagings[slot]!, rgba, g.reset, buffers[slot]!, p.rowPitch);
          const value = submit.submit(slot);
          frames++;
          encW.postMessage({ type: "frame", slot, value });
        } catch (err) { fail(`engine: ${(err as Error).message}`); }
      } else if (m.type === "end") {
        decodeEnded = true; maybeFinish();
      } else if (m.type === "error") {
        fail(`decode: ${m.message}`);
      }
    };

    encW.postMessage({
      type: "open", ffmpeg: p.ffmpeg, sinkArgs: p.sinkArgs,
      bufHandles, fenceHandle, size: p.totalBytes,
      width: p.width, height: p.height, pitch: p.rowPitch,
      fpsNum: p.enc.fpsNum, fpsDen: p.enc.fpsDen, codec: p.enc.codec, cq: p.enc.cq, ordinal: p.enc.ordinal,
    });
  });
}
