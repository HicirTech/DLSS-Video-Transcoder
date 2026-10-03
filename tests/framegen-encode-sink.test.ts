/**
 * EncodeSink.open (src/pipeline/framegen-encode-sink.ts), which starts the frame-generation encode
 * worker: when the open fails the caller is handed no sink, so the open itself must end the thread.
 * Stand-in workers answer the open; one case runs the real worker.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncodeSink } from "../src/pipeline/framegen-encode-sink.ts";
import type { FramegenEncodeOpen } from "../src/pipeline/workers/framegen-encode-worker.ts";
import { FakeWorker, RefusingWorker } from "./fake-worker.ts";

/** No NVENC, so the worker never touches the GPU: it only spawns the ffmpeg it is told to. */
const OPEN: FramegenEncodeOpen = { type: "open", ffmpeg: "ffmpeg", nvencArgs: [], rawArgs: ["-i", "pipe:0"], nvenc: null };

describe("EncodeSink.open", () => {
  test("an error reply ends the worker and rejects with what it said", async () => {
    const worker = new FakeWorker();
    const opening = EncodeSink.open(OPEN, () => worker.asWorker());
    expect(worker.sent).toEqual([OPEN]);
    worker.reply({ type: "error", message: "frame-generation encode worker could not start: ENOENT" });
    await expect(opening).rejects.toThrow("could not start: ENOENT");
    expect(worker.terminated).toBe(true);
  });

  test("a worker that crashes while loading is ended too", async () => {
    const worker = new FakeWorker();
    const opening = EncodeSink.open(OPEN, () => worker.asWorker());
    worker.crash("Cannot find module nvEncodeAPI64.dll");
    await expect(opening).rejects.toThrow("encode worker crashed: Cannot find module nvEncodeAPI64.dll");
    expect(worker.terminated).toBe(true);
  });

  test("so is a worker that cannot be sent the open message", async () => {
    const worker = new RefusingWorker();
    await expect(EncodeSink.open(OPEN, () => worker.asWorker())).rejects.toThrow("DataCloneError");
    expect(worker.terminated).toBe(true);
  });

  test("a worker that opens is kept, and the sink it belongs to ends it", async () => {
    const worker = new FakeWorker();
    const opening = EncodeSink.open(OPEN, () => worker.asWorker());
    worker.reply({ type: "opened", nvenc: true, note: "encode: NVENC h264" });
    const sink = await opening;
    expect(sink.usesNvenc).toBe(true);
    expect(worker.terminated).toBe(false);
    sink.close();
    expect(worker.terminated).toBe(true);
  });

  test("the real worker, told to spawn an ffmpeg that is not there, answers with an error and its thread is ended", async () => {
    const missingFfmpeg = join(tmpdir(), "no-such-folder-for-the-encode-sink-test", "ffmpeg.exe");
    let started: Worker | null = null;
    let terminateCalls = 0;
    let threadEnded: () => void = () => {};
    const ended = new Promise<void>((resolve) => { threadEnded = resolve; });
    try {
      const opening = EncodeSink.open({ ...OPEN, ffmpeg: missingFfmpeg }, (script) => {
        const worker = new Worker(script.href);
        started = worker;
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { terminateCalls++; return terminate(); };
        worker.addEventListener("close", () => threadEnded());
        return worker;
      });
      await expect(opening).rejects.toThrow("frame-generation encode worker could not start");
      await Promise.race([ended, Bun.sleep(5000).then(() => { throw new Error("the worker thread was still running 5 s after its open failed"); })]);
      expect(terminateCalls).toBe(1);
    } finally {
      (started as Worker | null)?.terminate();
    }
  });
});
