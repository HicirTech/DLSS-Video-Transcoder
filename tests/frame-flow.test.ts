/**
 * The flow of frames between the decode and encode workers (src/pipeline/frame-flow.ts), driven with
 * stand-in workers: the credits, the acknowledgements, the progress line, the finish condition and
 * the failure messages that both video encode orchestrators share.
 */
import { describe, expect, test } from "bun:test";
import { type FrameCounts, connectFrameFlow } from "../src/pipeline/frame-flow.ts";
import { RunFailedError, framesWrittenOf } from "../src/pipeline/partial-output.ts";
import { WorkerPairRun } from "../src/pipeline/worker-pair-run.ts";
import { FakeWorker } from "./fake-worker.ts";

const CREDIT_WINDOW = 4;

type Outcome = { value?: FrameCounts; error?: Error };

function start(processFrame: (frame: { index: number; buf: ArrayBuffer }, frameNumber: number) => boolean = () => false) {
  const decode = new FakeWorker();
  const encode = new FakeWorker();
  const controller = new AbortController();
  const progress: Array<[number, string, number | undefined]> = [];
  const acks: unknown[] = [];
  let encodeReplies = 0;
  const outcome = new Promise<Outcome>((resolve) => {
    const run = new WorkerPairRun<FrameCounts>({
      decodeWorker: decode.asWorker(),
      encodeWorker: encode.asWorker(),
      signal: controller.signal,
      resolve: (value) => resolve({ value }),
      reject: (error) => resolve({ error }),
    });
    connectFrameFlow(run, {
      decodeWorker: decode.asWorker(),
      encodeWorker: encode.asWorker(),
      decodeStart: { ffmpeg: "ffmpeg", args: ["-i", "in.mp4"], frameBytes: 16 },
      creditWindow: CREDIT_WINDOW,
      totalFrames: 10,
      onProgress: (fraction, message, frames) => progress.push([fraction, message, frames]),
      processFrame,
      onEncodeReply: () => { encodeReplies++; },
      onEncoded: (ack) => acks.push(ack),
    });
  });
  return { decode, encode, controller, progress, acks, encodeReplies: () => encodeReplies, outcome };
}

type Flow = ReturnType<typeof start>;

const frame = (index: number) => ({ type: "frame", index, buf: new ArrayBuffer(16) });
const credits = (flow: Flow): number[] => flow.decode.sentOfType("credit").map((message) => (message as { n: number }).n);

function acknowledgeAbort(flow: Flow): void {
  flow.decode.reply({ type: "aborted" });
  flow.encode.reply({ type: "aborted" });
}

describe("connectFrameFlow", () => {
  test("the encoder opening starts the decode worker and gives it the whole credit window", () => {
    const flow = start();
    flow.encode.reply({ type: "opened" });
    expect(flow.decode.sentOfType("start")).toEqual([{ type: "start", ffmpeg: "ffmpeg", args: ["-i", "in.mp4"], frameBytes: 16 }]);
    expect(credits(flow)).toEqual([CREDIT_WINDOW]);
  });

  test("each decoded frame goes through the per-frame step in order, and its scene cuts are counted", async () => {
    const seen: Array<[number, number]> = [];
    const flow = start((decoded, frameNumber) => {
      seen.push([decoded.index, frameNumber]);
      return decoded.index === 1;
    });
    flow.encode.reply({ type: "opened" });
    for (const index of [0, 1, 2]) flow.decode.reply(frame(index));
    expect(seen).toEqual([[0, 0], [1, 1], [2, 2]]);
    flow.decode.reply({ type: "end", frames: 3 });
    for (let acked = 0; acked < 3; acked++) flow.encode.reply({ type: "encoded" });
    flow.encode.reply({ type: "done" });
    expect((await flow.outcome).value).toEqual({ frames: 3, sceneCuts: 1 });
  });

  test("each acknowledgement gives the decode worker one more credit and reports progress, until decoding has ended", () => {
    const flow = start();
    flow.encode.reply({ type: "opened" });
    flow.decode.reply(frame(0));
    flow.decode.reply(frame(1));
    flow.encode.reply({ type: "encoded", slot: 0 });
    expect(credits(flow)).toEqual([CREDIT_WINDOW, 1]);
    expect(flow.progress).toEqual([[0.1, "frame 1/10", 1]]);
    expect(flow.acks).toEqual([{ type: "encoded", slot: 0 }]);
    flow.decode.reply({ type: "end", frames: 2 });
    flow.encode.reply({ type: "encoded", slot: 1 });
    expect(credits(flow)).toEqual([CREDIT_WINDOW, 1]); // nothing left to decode, so no more credit
    expect(flow.progress).toHaveLength(2);
  });

  test("the encoder is told to finish once, when decoding has ended and every frame handed over is acknowledged", () => {
    const flow = start();
    flow.encode.reply({ type: "opened" });
    flow.decode.reply(frame(0));
    flow.decode.reply({ type: "end", frames: 1 });
    expect(flow.encode.sentOfType("finish")).toHaveLength(0); // the frame is not acknowledged yet
    flow.encode.reply({ type: "encoded" });
    expect(flow.encode.sentOfType("finish")).toHaveLength(1);
    flow.decode.reply({ type: "end", frames: 1 });
    expect(flow.encode.sentOfType("finish")).toHaveLength(1);
  });

  test("a failure names the stage it came from, and carries the frames already written", async () => {
    const cases: Array<[string, (flow: Flow) => void]> = [
      ["encode: NVENC died", (flow) => flow.encode.reply({ type: "error", message: "NVENC died" })],
      ["decode: ffmpeg decode failed (1): bad input", (flow) => flow.decode.reply({ type: "error", message: "ffmpeg decode failed (1): bad input" })],
    ];
    for (const [expected, cause] of cases) {
      const flow = start();
      flow.encode.reply({ type: "opened" });
      flow.encode.reply({ type: "encoded" });
      cause(flow);
      acknowledgeAbort(flow);
      const { error } = await flow.outcome;
      expect(error).toBeInstanceOf(RunFailedError);
      expect(error!.message).toBe(expected);
      expect(framesWrittenOf(error)).toBe(1);
    }
  });

  test("a per-frame step that throws fails the run as an engine error", async () => {
    const flow = start(() => {
      throw new Error("device removed");
    });
    flow.encode.reply({ type: "opened" });
    flow.decode.reply(frame(0));
    acknowledgeAbort(flow);
    expect((await flow.outcome).error!.message).toBe("engine: device removed");
  });

  test("a reply that arrives after a stop is still seen by the owner, but starts and reports nothing", async () => {
    const flow = start();
    flow.controller.abort();
    flow.encode.reply({ type: "opened" });
    flow.encode.reply({ type: "encoded" });
    expect(flow.encodeReplies()).toBe(2);
    expect(flow.decode.sentOfType("start")).toHaveLength(0);
    expect(flow.acks).toHaveLength(0);
    expect(flow.progress).toHaveLength(0);
    acknowledgeAbort(flow);
    expect(framesWrittenOf((await flow.outcome).error)).toBe(1); // the ack still counts toward the frames written
  });
});
