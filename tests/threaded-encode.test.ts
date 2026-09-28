/**
 * The threaded encode orchestrator (src/pipeline/threaded-encode.ts) with
 * stand-in workers and a pass-through engine: what it does with worker
 * messages that arrive around a cancellation.
 */
import { describe, expect, test } from "bun:test";
import { JobCancelledError } from "../src/pipeline/cancel.ts";
import type { Engine } from "../src/pipeline/engine.ts";
import { framesWrittenOf } from "../src/pipeline/partial-output.ts";
import { runThreadedEncode } from "../src/pipeline/threaded-encode.ts";
import { FakeWorker } from "./fake-worker.ts";

type Outcome = { value?: { frames: number; sceneCuts: number }; error?: Error };

function start(signal: AbortSignal, onFinishing?: () => void) {
  const decode = new FakeWorker();
  const encode = new FakeWorker();
  const counts = { workersCreated: 0, engineCalls: 0 };
  const engine: Engine = {
    name: "pass-through",
    width: 2,
    height: 2,
    outputWidth: 2,
    outputHeight: 2,
    process: ({ rgba }) => {
      counts.engineCalls++;
      return new Uint8Array(rgba);
    },
    close: () => {},
  };
  const result: Promise<Outcome> = (async () => {
    try {
      return {
        value: await runThreadedEncode({
          engine,
          ffmpeg: "ffmpeg",
          decodeArgs: [],
          frameBytes: 16,
          sinkArgs: [],
          enc: { width: 2, height: 2, fpsNum: 30, fpsDen: 1, codec: "h264", ordinal: 0 },
          totalFrames: 2,
          guide: () => ({ reset: false, motion: null, sceneCut: false }),
          signal,
          onFinishing,
          createWorker: (script) => {
            counts.workersCreated++;
            return (script.pathname.endsWith("decode-worker.ts") ? decode : encode).asWorker();
          },
        }),
      };
    } catch (error) {
      return { error: error as Error };
    }
  })();
  return { decode, encode, counts, result };
}

function frame(): ArrayBuffer {
  return new Uint8Array(16).buffer;
}

function acknowledgeAbort(run: { decode: FakeWorker; encode: FakeWorker }): void {
  run.decode.reply({ type: "aborted" });
  run.encode.reply({ type: "aborted" });
}

describe("runThreadedEncode", () => {
  test("an already-aborted signal is refused before any worker is started", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = start(controller.signal);
    expect((await run.result).error).toBeInstanceOf(JobCancelledError);
    expect(run.counts.workersCreated).toBe(0);
  });

  test("an encoder that answers 'opened' after a cancel does not start the decoder", async () => {
    const controller = new AbortController();
    const run = start(controller.signal);
    controller.abort();
    run.encode.reply({ type: "opened" });
    expect(run.decode.sentOfType("start")).toHaveLength(0);
    acknowledgeAbort(run);
    expect((await run.result).error).toBeInstanceOf(JobCancelledError);
  });

  test("a decoded frame that arrives after a cancel is not processed or sent to the encoder", async () => {
    const controller = new AbortController();
    const run = start(controller.signal);
    run.encode.reply({ type: "opened" });
    controller.abort();
    run.decode.reply({ type: "frame", index: 0, buf: frame() });
    expect(run.counts.engineCalls).toBe(0);
    expect(run.encode.sentOfType("frame")).toHaveLength(0);
    acknowledgeAbort(run);
    await run.result;
  });

  test("an 'encoded' ack that arrives during the stop still counts toward the frames written", async () => {
    const controller = new AbortController();
    const run = start(controller.signal);
    run.encode.reply({ type: "opened" });
    run.decode.reply({ type: "frame", index: 0, buf: frame() });
    controller.abort();
    run.encode.reply({ type: "encoded", index: 0 });
    acknowledgeAbort(run);
    expect(framesWrittenOf((await run.result).error)).toBe(1);
  });

  test("once every frame is encoded and finish is sent, a cancel lets the run complete", async () => {
    const controller = new AbortController();
    let finishing = 0;
    const run = start(controller.signal, () => { finishing++; });
    run.encode.reply({ type: "opened" });
    run.decode.reply({ type: "frame", index: 0, buf: frame() });
    run.encode.reply({ type: "encoded", index: 0 });
    run.decode.reply({ type: "end", frames: 1 });
    expect(run.encode.sentOfType("finish")).toHaveLength(1);
    expect(finishing).toBe(1);
    controller.abort();
    expect(run.encode.sentOfType("abort")).toHaveLength(0);
    run.encode.reply({ type: "done" });
    expect(await run.result).toEqual({ value: { frames: 1, sceneCuts: 0 } });
  });
});
