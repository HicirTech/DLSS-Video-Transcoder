/**
 * Decode-stage worker for the threaded video pipeline.
 *
 * Runs the ffmpeg rawvideo decode on its own OS thread and hands whole RGBA
 * frames to the main thread as transferable ArrayBuffers (zero-copy). Reading
 * happens here so it overlaps with the main thread's (synchronous, blocking)
 * DLSS work — on a single thread the decode pipe cannot drain while an FFI call
 * blocks, which is what serialised the old loop.
 *
 * Flow control is credit-based: the main thread grants credits (one per frame it
 * can accept); this worker only reads and posts a frame when it holds a credit,
 * bounding how far decode may run ahead and thus total memory use.
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
    const err = (await new Response(proc.stderr).text()).trim();
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
