/**
 * Decode-stage worker for the threaded video pipeline: runs the ffmpeg rawvideo
 * decode on its own OS thread and hands whole RGBA frames to the main thread as
 * transferred ArrayBuffers.
 *
 * Reading happens on this thread so it overlaps the main thread's synchronous,
 * blocking DLSS calls, which would otherwise stop the decode pipe from draining.
 * Flow control is credit-based: the main thread grants one credit per frame it
 * can accept and a frame is only read and posted while a credit is held, which
 * bounds how far decode runs ahead and so the memory it ties up.
 */
import { ffmpegFailedMessage } from "../ffmpeg-failure.ts";
import { FrameReader } from "../frame-reader.ts";
import { type AbortedReply, type AbortRequest, answerAbort } from "../worker-abort.ts";

/** Spawn ffmpeg with `args` and read `frameBytes` per frame from its stdout. */
export interface DecodeStart { type: "start"; ffmpeg: string; args: string[]; frameBytes: number }
/** Allow `n` more frames to be read and posted. */
export interface DecodeCredit { type: "credit"; n: number }
/** What the main thread sends the decode worker. */
export type DecodeIn = DecodeStart | DecodeCredit | AbortRequest;
/** What it answers: each frame (its buffer transferred), then "end" or "error". */
export type DecodeOut =
  | { type: "frame"; index: number; buf: ArrayBuffer }
  | { type: "end"; frames: number }
  | { type: "error"; message: string }
  | AbortedReply;

declare const self: Worker;

const post = (message: DecodeOut, transfer?: Transferable[]): void => (transfer ? self.postMessage(message, transfer) : self.postMessage(message));

let credits = 0;
let wake: (() => void) | null = null;
let proc: ReturnType<typeof Bun.spawn> | null = null;
let aborted = false;

/** Release a read waiting on a credit. */
function wakeReader(): void {
  if (wake) { const w = wake; wake = null; w(); }
}

function awaitCredit(): Promise<void> {
  if (credits > 0) return Promise.resolve();
  return new Promise<void>((resolve) => { wake = resolve; });
}

self.onmessage = (event: MessageEvent<DecodeIn>) => {
  const msg = event.data;
  if (msg.type === "start") {
    void run(msg);
  } else if (msg.type === "credit") {
    credits += msg.n;
    wakeReader();
  } else if (msg.type === "abort") {
    aborted = true;
    // Woken, the read loop sees `aborted` and returns instead of waiting on a credit that never comes.
    wakeReader();
    void answerAbort(self, proc);
  }
};

async function run(msg: DecodeStart): Promise<void> {
  // A "start" queued behind an "abort" must not spawn: the abort was already
  // acknowledged, so nothing would ever kill that ffmpeg.
  if (aborted) return;
  try {
    proc = Bun.spawn([msg.ffmpeg, ...msg.args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    // Drain stderr concurrently so a chatty ffmpeg can't fill the stderr pipe,
    // block, and stall stdout (which would hang the read loop below).
    let stderrText = "";
    const stderrDrained = new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((t) => { stderrText = t; }).catch(() => {});
    const reader = new FrameReader(proc.stdout as ReadableStream<Uint8Array>);
    let index = 0;
    for (;;) {
      await awaitCredit();
      if (aborted) return; // the abort handler acknowledges; nothing more is posted
      const frame = await reader.next(msg.frameBytes);
      if (!frame || aborted) break;
      credits--;
      // FrameReader hands out ordinary (not shared) memory unless it was asked to, so this buffer can be transferred.
      const buf = frame.buffer as ArrayBuffer;
      post({ type: "frame", index, buf }, [buf]);
      index++;
    }
    await stderrDrained;
    const err = stderrText.trim();
    const code = await proc.exited;
    if (aborted) return;
    if (code !== 0) {
      post({ type: "error", message: ffmpegFailedMessage("decode", code, err) });
      return;
    }
    post({ type: "end", frames: index });
  } catch (error) {
    if (aborted) return;
    post({ type: "error", message: (error as Error).message ?? String(error) });
  }
}
