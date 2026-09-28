/**
 * The decode worker (src/pipeline/workers/decode-worker.ts) answering an
 * abort, run as a real Worker with a stand-in child in place of ffmpeg: an
 * abort that arrives before "start" must keep it from spawning at all, and one
 * that arrives mid-run must end the child before the worker acknowledges.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DECODE_WORKER = new URL("../src/pipeline/workers/decode-worker.ts", import.meta.url).href;

const dirs: string[] = [];
const workers: Worker[] = [];
/** Stand-in children a failed test may have left running: terminating a Worker does not end its children. */
const childPids: number[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone, as it should be
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function decodeWorker(): Worker {
  const worker = new Worker(DECODE_WORKER);
  workers.push(worker);
  return worker;
}

function markerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "decode-abort-"));
  dirs.push(dir);
  return join(dir, "pid.txt");
}

/** A child that records its pid in `marker`, then streams bytes until killed. */
function streamingChild(marker: string): string[] {
  const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => process.stdout.write(Buffer.alloc(4096)), 1);`;
  return ["-e", script];
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collect(worker: Worker): string[] {
  const seen: string[] = [];
  worker.addEventListener("message", (event) => seen.push((event as MessageEvent).data.type));
  return seen;
}

function nextMessage(worker: Worker, type: string): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      if (event.data?.type !== type) return;
      worker.removeEventListener("message", onMessage);
      resolve();
    };
    worker.addEventListener("message", onMessage);
  });
}

describe("decode worker abort", () => {
  test("an abort before start acknowledges and the later start spawns nothing", async () => {
    const worker = decodeWorker();
    const seen = collect(worker);
    const marker = markerPath();
    const aborted = nextMessage(worker, "aborted");
    worker.postMessage({ type: "abort" });
    worker.postMessage({ type: "start", ffmpeg: process.execPath, args: streamingChild(marker), frameBytes: 4096 });
    worker.postMessage({ type: "credit", n: 4 });
    await aborted;
    // The stand-in child writes its marker 18-30 ms after spawning (measured); 500 ms leaves a wide margin.
    await Bun.sleep(500);
    expect(existsSync(marker)).toBe(false);
    expect(seen).toEqual(["aborted"]);
  });

  test("an abort mid-run ends the child before the worker acknowledges", async () => {
    const worker = decodeWorker();
    const marker = markerPath();
    const firstFrame = nextMessage(worker, "frame");
    worker.postMessage({ type: "start", ffmpeg: process.execPath, args: streamingChild(marker), frameBytes: 4096 });
    worker.postMessage({ type: "credit", n: 1 });
    await firstFrame;
    const pid = Number(readFileSync(marker, "utf8"));
    childPids.push(pid);
    expect(isRunning(pid)).toBe(true);
    const aborted = nextMessage(worker, "aborted");
    worker.postMessage({ type: "abort" });
    await aborted;
    expect(isRunning(pid)).toBe(false);
  });
});
