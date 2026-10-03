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
import { type AbortRequest, answerAbort } from "../worker-abort.ts";

interface StartMsg { type: "start"; ffmpeg: string; args: string[]; frameBytes: number }
interface CreditMsg { type: "credit"; n: number }
type InMsg = StartMsg | CreditMsg | AbortRequest;

declare const self: Worker;

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

self.onmessage = (event: MessageEvent<InMsg>) => {
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

async function run(msg: StartMsg): Promise<void> {
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
      self.postMessage({ type: "frame", index, buf: frame.buffer }, [frame.buffer]);
      index++;
    }
    await stderrDrained;
    const err = stderrText.trim();
    const code = await proc.exited;
    if (aborted) return;
    if (code !== 0) {
      self.postMessage({ type: "error", message: ffmpegFailedMessage("decode", code, err) });
      return;
    }
    self.postMessage({ type: "end", frames: index });
  } catch (error) {
    if (aborted) return;
    self.postMessage({ type: "error", message: (error as Error).message ?? String(error) });
  }
}
