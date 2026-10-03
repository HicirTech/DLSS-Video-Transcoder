/**
 * Encode-stage worker for frame generation: owns the NVENC encoder and the
 * mux/encode ffmpeg child, encoding each finished output frame on the GPU (or
 * passing the raw RGBA through for the CPU codecs) into ffmpeg's stdin.
 *
 * It is a worker because `NvencEncoder.encode` is a synchronous FFI call
 * costing ~3.2 ms per output frame, which on the coordinator thread stalls the
 * loop feeding the guide threads and the DLSSG host processes. NVENC's CUDA
 * context is therefore created here, on the thread that uses it. Frames arrive
 * as SharedArrayBuffer-backed RGBA, so posting them costs nothing; display
 * order holds because every request is appended to a single promise chain.
 */
import { ffmpegFailedMessage } from "../ffmpeg-failure.ts";
import { FRAMEGEN_CUDA_DEVICE } from "../framegen-plan.ts";
import { NvencEncoder, probeNvencCaps, type NvencSdkCodec } from "../nvenc.ts";
import { type AbortedReply, type AbortRequest, answerAbort } from "../worker-abort.ts";

/** Open the encoder (when `nvenc` is set and NVENC comes up) and the ffmpeg child that muxes or encodes. */
export interface FramegenEncodeOpen {
  type: "open";
  ffmpeg: string;
  /** ffmpeg argv for the NVENC path (mux-only, `-c:v copy` from an elementary stream). */
  nvencArgs: string[];
  /** ffmpeg argv for the rawvideo path (ffmpeg does the encoding). */
  rawArgs: string[];
  /** NVENC configuration, or null when the codec has no NVENC equivalent. The device is FRAMEGEN_CUDA_DEVICE. */
  nvenc: { width: number; height: number; fpsNum: number; fpsDen: number; codec: NvencSdkCodec; cq: number } | null;
}
/** One finished output frame (SharedArrayBuffer-backed, so posting it copies nothing). */
export interface FramegenEncodeFrame {
  type: "frame";
  rgba: Uint8Array;
}
/** What the main thread sends the frame-generation encode worker. */
export type FramegenEncodeIn = FramegenEncodeOpen | FramegenEncodeFrame | { type: "finish" } | AbortRequest;
/** What it answers: whether NVENC is in use (and a note on why not), one ack per frame, then "done" or "error". */
export type FramegenEncodeOut =
  | { type: "opened"; nvenc: boolean; note: string }
  | { type: "encoded" }
  | { type: "done" }
  | { type: "error"; message: string }
  | AbortedReply;

declare const self: Worker;

const post = (message: FramegenEncodeOut): void => self.postMessage(message);

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
  post({ type: "error", message });
}

/** ffmpeg's own diagnostics, once it has exited (bounded wait so a live process cannot hang the error path). */
async function ffmpegDetail(): Promise<string> {
  await Promise.race([stderrDrained, new Promise((resolve) => setTimeout(resolve, 2000))]);
  const text = stderrText.trim();
  return text ? `: ${text}` : "";
}

self.onmessage = (event: MessageEvent<FramegenEncodeIn>) => {
  const m = event.data;
  if (m.type === "open") {
    try {
      let note = "";
      if (m.nvenc && probeNvencCaps(FRAMEGEN_CUDA_DEVICE).available) {
        try {
          enc = NvencEncoder.open({ ...m.nvenc, ordinal: FRAMEGEN_CUDA_DEVICE });
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
      post({ type: "opened", nvenc: Boolean(enc), note });
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
        post({ type: "encoded" });
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
          fail(ffmpegFailedMessage("encode", code, stderrText));
          return;
        }
        stopped = true;
        post({ type: "done" });
      })
      .catch(async (error) => {
        try { proc?.kill(); } catch {}
        fail(`ffmpeg encode failed${await ffmpegDetail()} (${(error as Error).message ?? String(error)})`);
      });
  } else if (m.type === "abort") {
    // Immediate, not chained: stop feeding ffmpeg, kill it and release the
    // output file so the caller can delete it, then acknowledge.
    stopped = true;
    void answerAbort(self, proc, () => { enc?.close(); enc = null; });
  }
};
