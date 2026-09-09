/**
 * Encode-stage worker for frame generation.
 *
 * Owns the NVENC encoder and the mux/encode ffmpeg child: it receives finished
 * output frames in display order, encodes each on the GPU (or passes the raw
 * RGBA through for the CPU codecs) and writes the result to ffmpeg's stdin.
 *
 * This runs off the main thread because `NvencEncoder.encode` is a synchronous
 * FFI call — at 240 fps it was ~3.2 ms per output frame on the coordinator
 * thread (97 s of a 180 s run), blocking the loop that feeds the guide threads
 * and the DLSSG worker processes. NVENC opens its own CUDA context here, on the
 * thread that uses it. Frames arrive as SharedArrayBuffer-backed RGBA, so
 * posting them costs nothing; ordering is preserved because every request is
 * appended to a single promise chain.
 */
import { NvencEncoder, probeNvenc, type NvencCodec } from "../nvenc.ts";

interface OpenMsg {
  type: "open";
  ffmpeg: string;
  /** ffmpeg argv for the NVENC path (mux-only, `-c:v copy` from an elementary stream). */
  nvencArgs: string[];
  /** ffmpeg argv for the rawvideo path (ffmpeg does the encoding). */
  rawArgs: string[];
  /** NVENC configuration, or null when the codec has no NVENC equivalent. */
  nvenc: { width: number; height: number; fpsNum: number; fpsDen: number; codec: NvencCodec; cq: number; ordinal?: number } | null;
}
interface FrameMsg {
  type: "frame";
  rgba: Uint8Array;
}
type InMsg = OpenMsg | FrameMsg | { type: "finish" } | { type: "abort" };

declare const self: Worker;

let enc: NvencEncoder | null = null;
let proc: ReturnType<typeof Bun.spawn> | null = null;
let sink: { write(b: Uint8Array): unknown; end(): unknown } | null = null;
let stderrText = "";
let stderrDrained: Promise<void> = Promise.resolve();
let chain: Promise<void> = Promise.resolve();
let stopped = false;

function fail(message: string): void {
  if (stopped) return;
  stopped = true;
  self.postMessage({ type: "error", message });
}

/** ffmpeg's own diagnostics, once it has exited (bounded wait so a live process cannot hang the error path). */
async function ffmpegDetail(): Promise<string> {
  await Promise.race([stderrDrained, new Promise((resolve) => setTimeout(resolve, 2000))]);
  const text = stderrText.trim();
  return text ? `: ${text}` : "";
}

self.onmessage = (event: MessageEvent<InMsg>) => {
  const m = event.data;
  if (m.type === "open") {
    try {
      let note = "";
      if (m.nvenc && probeNvenc(m.nvenc.ordinal ?? 0).available) {
        try {
          enc = NvencEncoder.open({ ...m.nvenc, preset: "p5" });
          note = `encode: NVENC ${m.nvenc.codec} (GPU, mux-only pipe, encode thread)`;
        } catch (error) {
          enc = null;
          note = `encode: NVENC direct path unavailable (${(error as Error).message}); using rawvideo pipe`;
        }
      }
      proc = Bun.spawn([m.ffmpeg, ...(enc ? m.nvencArgs : m.rawArgs)], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
      sink = proc.stdin as { write(b: Uint8Array): unknown; end(): unknown };
      // Drain stderr for the whole run so ffmpeg can never block on a full pipe.
      stderrDrained = new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((t) => { stderrText = t; }).catch(() => {});
      self.postMessage({ type: "opened", nvenc: Boolean(enc), note });
    } catch (error) {
      fail(`frame-generation encode worker could not start: ${(error as Error).message ?? String(error)}`);
    }
  } else if (m.type === "frame") {
    chain = chain
      .then(async () => {
        if (stopped || !sink) return;
        const payload = enc ? enc.encode(m.rgba) : m.rgba;
        const written = sink.write(payload);
        if (written instanceof Promise) await written;
        self.postMessage({ type: "encoded" });
      })
      .catch(async (error) => {
        try { proc?.kill(); } catch {}
        fail(`ffmpeg encode failed${await ffmpegDetail()} (${(error as Error).message ?? String(error)})`);
      });
  } else if (m.type === "finish") {
    chain = chain
      .then(async () => {
        if (stopped || !sink || !proc) return;
        // Flush anything NVENC still holds before closing the pipe.
        if (enc) {
          const tail = enc.finish();
          if (tail.length) {
            const written = sink.write(tail);
            if (written instanceof Promise) await written;
          }
        }
        sink.end();
        await stderrDrained;
        const code = await proc.exited;
        enc?.close();
        enc = null;
        if (code !== 0) {
          fail(`ffmpeg encode failed (${code}): ${stderrText.trim()}`);
          return;
        }
        stopped = true;
        self.postMessage({ type: "done" });
      })
      .catch(async (error) => {
        try { proc?.kill(); } catch {}
        fail(`ffmpeg encode failed${await ffmpegDetail()} (${(error as Error).message ?? String(error)})`);
      });
  } else if (m.type === "abort") {
    // Immediate, not chained: stop feeding ffmpeg, kill it and release the
    // output file so the caller can delete it, then acknowledge.
    stopped = true;
    void (async () => {
      try { proc?.kill(); } catch {}
      try { enc?.close(); } catch {}
      enc = null;
      try { await proc?.exited; } catch {}
      self.postMessage({ type: "aborted" });
    })();
  }
};
