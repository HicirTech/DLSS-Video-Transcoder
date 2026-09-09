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
import { FrameReader } from "../frame-reader.ts";

interface StartMsg { type: "start"; ffmpeg: string; args: string[]; frameBytes: number }
interface CreditMsg { type: "credit"; n: number }
type InMsg = StartMsg | CreditMsg;

declare const self: Worker;

let credits = 0;
let wake: (() => void) | null = null;

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
    if (wake) { const w = wake; wake = null; w(); }
  }
};

async function run(msg: StartMsg): Promise<void> {
  try {
    const proc = Bun.spawn([msg.ffmpeg, ...msg.args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    // Drain stderr concurrently so a chatty ffmpeg can't fill the stderr pipe,
    // block, and stall stdout (which would hang the read loop below).
    let stderrText = "";
    const stderrDrained = new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((t) => { stderrText = t; }).catch(() => {});
    const reader = new FrameReader(proc.stdout as ReadableStream<Uint8Array>);
    let index = 0;
    for (;;) {
      await awaitCredit();
      const frame = await reader.next(msg.frameBytes);
      if (!frame) break;
      credits--;
      self.postMessage({ type: "frame", index, buf: frame.buffer }, [frame.buffer]);
      index++;
    }
    await stderrDrained;
    const err = stderrText.trim();
    const code = await proc.exited;
    if (code !== 0) {
      self.postMessage({ type: "error", message: `ffmpeg decode failed (${code}): ${err}` });
      return;
    }
    self.postMessage({ type: "end", frames: index });
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message ?? String(error) });
  }
}
