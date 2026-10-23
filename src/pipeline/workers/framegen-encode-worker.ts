/**
 * Encode-stage worker for frame generation: owns the NVENC encoder and the
 * mux/encode ffmpeg child, encoding each finished output frame on the GPU (or
 * passing the raw RGBA through for the CPU codecs) into ffmpeg's stdin.
 */
import { ffmpegFailedMessage } from "../ffmpeg-failure.ts";
import { FRAMEGEN_CUDA_DEVICE } from "../framegen-device.ts";
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
interface FramegenEncodeFrame {
  type: "frame";
  rgba: Uint8Array;
}
/** What the main thread sends the frame-generation encode worker. */
type FramegenEncodeIn = FramegenEncodeOpen | FramegenEncodeFrame | { type: "finish" } | AbortRequest;
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
// Every request is appended to this one chain, so frames reach ffmpeg in display order.
let chain: Promise<void> = Promise.resolve();
let stopped = false;

function fail(message: string): void {
  if (stopped) return;
  stopped = true;
  post({ type: "error", message });
}

/** How long the error path waits for ffmpeg's stderr after the kill, so its diagnostics reach the message without a wedged child holding up the failure report. */
const STDERR_DRAIN_TIMEOUT_MS = 2000;

/** ffmpeg's own diagnostics, once it has exited (bounded by STDERR_DRAIN_TIMEOUT_MS). */
async function ffmpegDetail(): Promise<string> {
  await Promise.race([stderrDrained, new Promise((resolve) => setTimeout(resolve, STDERR_DRAIN_TIMEOUT_MS))]);
  const text = stderrText.trim();
  return text ? `: ${text}` : "";
}

/** Kills ffmpeg and reports the failed encode with its own diagnostics. */
async function failEncode(error: unknown): Promise<void> {
  try { proc?.kill(); } catch {}
  fail(`ffmpeg encode failed${await ffmpegDetail()} (${(error as Error).message ?? String(error)})`);
}

/** Opens NVENC for `config`, or says why the rawvideo pipe is used instead. */
function openNvenc(config: NonNullable<FramegenEncodeOpen["nvenc"]>): { encoder: NvencEncoder | null; note: string } {
  try {
    return { encoder: NvencEncoder.open({ ...config, ordinal: FRAMEGEN_CUDA_DEVICE }), note: `encode: NVENC ${config.codec} (GPU, mux-only pipe, encode thread)` };
  } catch (error) {
    return { encoder: null, note: `encode: NVENC direct path unavailable (${(error as Error).message}); using rawvideo pipe` };
  }
}

/** Writes into ffmpeg's stdin, waiting while the pipe pushes back. */
async function writeToSink(bytes: Uint8Array): Promise<void> {
  const written = sink!.write(bytes);
  if (written instanceof Promise) await written;
}

/** Flushes NVENC, closes ffmpeg's stdin and reports how ffmpeg exited. */
async function finishEncode(): Promise<void> {
  if (stopped || !sink || !proc) return;
  // Flush anything NVENC still holds before closing the pipe.
  const tail = enc?.finish();
  if (tail?.length) await writeToSink(tail);
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
}

self.onmessage = (event: MessageEvent<FramegenEncodeIn>) => {
  const m = event.data;
  if (m.type === "open") {
    try {
      let note = "";
      // On this thread so the synchronous NVENC encode stays off the coordinator; its CUDA context is created here.
      if (m.nvenc) {
        const caps = probeNvencCaps(FRAMEGEN_CUDA_DEVICE);
        if (caps.available) ({ encoder: enc, note } = openNvenc(m.nvenc));
        else note = `encode: NVENC direct path unavailable (${caps.detail}); using rawvideo pipe`;
      }
      proc = Bun.spawn([m.ffmpeg, ...(enc ? m.nvencArgs : m.rawArgs)], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
      sink = proc.stdin as { write(b: Uint8Array): unknown; end(): unknown };
      // Drain stderr for the whole run so ffmpeg can never block on a full pipe.
      stderrDrained = new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((t) => { stderrText = t; }).catch(() => {});
      post({ type: "opened", nvenc: Boolean(enc), note });
    } catch (error) {
      // The main thread terminates this worker once it has the error, and terminate() runs no
      // JavaScript: an NVENC session opened before the spawn threw would outlive the thread.
      try { proc?.kill(); } catch {}
      enc?.close();
      enc = null;
      fail(`frame-generation encode worker could not start: ${(error as Error).message ?? String(error)}`);
    }
  } else if (m.type === "frame") {
    chain = chain
      .then(async () => {
        if (stopped || !sink) return;
        await writeToSink(enc ? enc.encode(m.rgba) : m.rgba);
        post({ type: "encoded" });
      })
      .catch(failEncode);
  } else if (m.type === "finish") {
    chain = chain.then(finishEncode).catch(failEncode);
  } else if (m.type === "abort") {
    // Immediate, not chained: stop feeding ffmpeg, kill it and release the
    // output file so the caller can delete it, then acknowledge.
    stopped = true;
    void answerAbort(self, proc, () => { enc?.close(); enc = null; });
  }
};
