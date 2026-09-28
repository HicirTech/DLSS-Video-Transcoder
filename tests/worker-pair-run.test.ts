/**
 * The decode/encode run lifecycle both video encode orchestrators share
 * (src/pipeline/worker-pair-run.ts), driven with stand-in workers: when a
 * cancellation stops the run, when it no longer can, and that the run settles
 * and releases exactly once.
 */
import { describe, expect, test } from "bun:test";
import { JobCancelledError } from "../src/pipeline/cancel.ts";
import { RunFailedError, framesWrittenOf } from "../src/pipeline/partial-output.ts";
import { WorkerPairRun } from "../src/pipeline/worker-pair-run.ts";
import { FakeWorker } from "./fake-worker.ts";

interface Harness {
  decode: FakeWorker;
  encode: FakeWorker;
  run: WorkerPairRun<string>;
  controller: AbortController;
  releases: () => number;
  finishings: () => number;
  outcome: Promise<{ result?: string; error?: Error }>;
}

function harness(options: { release?: () => void } = {}): Harness {
  const decode = new FakeWorker();
  const encode = new FakeWorker();
  const controller = new AbortController();
  let releaseCount = 0;
  let finishingCount = 0;
  let run!: WorkerPairRun<string>;
  const outcome = new Promise<{ result?: string; error?: Error }>((resolve) => {
    run = new WorkerPairRun<string>({
      decodeWorker: decode.asWorker(),
      encodeWorker: encode.asWorker(),
      signal: controller.signal,
      onFinishing: () => { finishingCount++; },
      release: () => { releaseCount++; options.release?.(); },
      resolve: (result) => resolve({ result }),
      reject: (error) => resolve({ error }),
    });
  });
  return { decode, encode, run, controller, releases: () => releaseCount, finishings: () => finishingCount, outcome };
}

/** Both stand-ins acknowledge the abort the run sent them. */
function acknowledgeAbort(h: Harness): void {
  h.decode.reply({ type: "aborted" });
  h.encode.reply({ type: "aborted" });
}

function recordEncoded(h: Harness, frames: number): void {
  for (let i = 0; i < frames; i++) h.run.recordEncoded();
}

describe("WorkerPairRun", () => {
  test("a cancellation while running asks both workers to stop and rejects only after they acknowledge", async () => {
    const h = harness();
    recordEncoded(h, 7);
    h.controller.abort();
    expect(h.run.active).toBe(false);
    expect(h.run.running).toBe(false);
    expect(h.decode.sentOfType("abort")).toHaveLength(1);
    expect(h.encode.sentOfType("abort")).toHaveLength(1);
    expect(h.releases()).toBe(0);
    acknowledgeAbort(h);
    const { error } = await h.outcome;
    expect(error).toBeInstanceOf(JobCancelledError);
    expect(framesWrittenOf(error)).toBe(7);
    expect(h.releases()).toBe(1);
    expect(h.decode.terminated && h.encode.terminated).toBe(true);
  });

  // Acks the encoder sent before its "aborted" arrive first and still count:
  // the count decides whether the partial output may be deleted.
  test("acknowledgements recorded during the stop are in the frame count the error carries", async () => {
    const h = harness();
    h.controller.abort();
    recordEncoded(h, 3);
    acknowledgeAbort(h);
    expect(framesWrittenOf((await h.outcome).error)).toBe(3);
  });

  test("finish tells the encode worker once, reports finishing once, and a later cancellation is ignored", async () => {
    const h = harness();
    recordEncoded(h, 100);
    h.run.finish();
    h.run.finish();
    expect(h.encode.sentOfType("finish")).toHaveLength(1);
    expect(h.finishings()).toBe(1);
    expect(h.run.running).toBe(false);
    expect(h.run.active).toBe(true);
    h.controller.abort();
    expect(h.encode.sentOfType("abort")).toHaveLength(0);
    h.run.succeed("done");
    expect(await h.outcome).toEqual({ result: "done" });
    expect(h.releases()).toBe(1);
  });

  test("a failure while finishing still stops the run and carries the frame count", async () => {
    const h = harness();
    recordEncoded(h, 42);
    h.run.finish();
    h.run.fail("encode: ffmpeg mux failed (1)");
    expect(h.encode.sentOfType("abort")).toHaveLength(1);
    acknowledgeAbort(h);
    const { error } = await h.outcome;
    expect(error).toBeInstanceOf(RunFailedError);
    expect(error!.message).toBe("encode: ffmpeg mux failed (1)");
    expect(framesWrittenOf(error)).toBe(42);
  });

  test("a crashed worker is not asked to abort, so the run settles without waiting for it", async () => {
    const h = harness();
    h.decode.crash("boom");
    expect(h.decode.sentOfType("abort")).toHaveLength(0);
    expect(h.encode.sentOfType("abort")).toHaveLength(1);
    h.encode.reply({ type: "aborted" });
    expect((await h.outcome).error!.message).toBe("decode worker crashed: boom");
  });

  test("the run settles once: a success after a stop, or a second failure, changes nothing", async () => {
    const h = harness();
    h.run.fail("first");
    h.run.fail("second");
    h.run.succeed("late");
    acknowledgeAbort(h);
    expect((await h.outcome).error!.message).toBe("first");
    expect(h.encode.sentOfType("abort")).toHaveLength(1);
    expect(h.releases()).toBe(1);
  });

  test("a release that throws on success rejects instead of resolving", async () => {
    const h = harness({ release: () => { throw new Error("fence release failed"); } });
    h.run.succeed("done");
    expect((await h.outcome).error!.message).toBe("fence release failed");
  });
});
