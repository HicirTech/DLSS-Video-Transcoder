/**
 * The frame-generation runners (src/pipeline/framegen-run.ts) over a stand-in decoder pipe and
 * stages: which frames they report as processed, so the job's progress moves for every plan, and how a
 * cancel and a failing check end them.
 */
import { describe, expect, test } from "bun:test";
import { JobCancelledError } from "../src/pipeline/cancel.ts";
import { FrameReader } from "../src/pipeline/frame-reader.ts";
import { NearestTimestampWriter } from "../src/pipeline/nearest-timestamp-writer.ts";
import { type RunParams, runOverlapped, runSequential } from "../src/pipeline/framegen-run.ts";
import type { AnalyzedFrame, PreparedFrame, Stage } from "../src/pipeline/framegen-stage.ts";
import { rational } from "../src/pipeline/rational.ts";

const FRAME_BYTES = 4;
const SOURCE_RATE = rational(30);

/** A decoder pipe holding `count` frames, cut into chunks that do not line up with the frames, as a real pipe's are. */
function decodedFrames(count: number): FrameReader {
  const bytes = new Uint8Array(count * FRAME_BYTES);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 5));
      controller.enqueue(bytes.subarray(5));
      controller.close();
    },
  });
  return new FrameReader(stream);
}

/** A stage whose evaluation hands the real frame back and generates nothing. */
function passThroughStage(): Stage {
  const stage = {
    generatedCount: 1,
    generatedTotal: 0,
    intervals: 0,
    prepare: async (frame: AnalyzedFrame["frame"]): Promise<AnalyzedFrame> => ({ frame, previousTimestamp: null, reset: true, kind: "packed", half: null }),
    pack: async (analyzed: AnalyzedFrame): Promise<PreparedFrame> => ({ frame: analyzed.frame, previousTimestamp: null, half: null, reset: true }),
    evaluate: async (prepared: PreparedFrame) => [prepared.frame],
  };
  return stage as unknown as Stage;
}

/** A stage whose evaluation aborts `controller` and then never settles, as one blocked on a wedged DLSS-G host does. */
function hangingStage(controller: AbortController): Stage {
  const evaluate = (): Promise<never> => {
    setTimeout(() => controller.abort(), 0);
    return new Promise<never>(() => {});
  };
  return { ...(passThroughStage() as object), evaluate } as unknown as Stage;
}

/**
 * `run`, or a rejection once `CANCEL_WAIT_MS` has passed: a runner that misses the cancel would otherwise wait on
 * the hung evaluation for good, and bun's own test timeout does not end that wait.
 */
const CANCEL_WAIT_MS = 2_000;
function settledInTime<T>(run: Promise<T>): Promise<T> {
  return Promise.race([run, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still running ${CANCEL_WAIT_MS} ms after the cancel`)), CANCEL_WAIT_MS))]);
}

function setup(frames: number, stages: Stage[], overrides: Partial<RunParams> = {}) {
  const processed: number[] = [];
  const writer = new NearestTimestampWriter(() => {}, SOURCE_RATE);
  const params: RunParams = {
    reader: decodedFrames(frames),
    frameBytes: FRAME_BYTES,
    sourceRate: SOURCE_RATE,
    stages,
    writer,
    capacity: 16,
    onProcessed: (count) => processed.push(count),
    check: () => {},
    ...overrides,
  };
  return { params, processed, writer };
}

describe("progress while frames run through the stages", () => {
  test("a plan with no stage (source-frame resampling) reports each decoded frame in the overlapped runner", async () => {
    const { params, processed, writer } = setup(5, []);
    const result = await runOverlapped(params);
    expect(result.decoded).toBe(5);
    expect(processed).toEqual([1, 2, 3, 4, 5]);
    expect(writer.nextIndex).toBe(5);
  });

  test("and in the sequential runner", async () => {
    const { params, processed, writer } = setup(5, []);
    const result = await runSequential(params);
    expect(result.decoded).toBe(5);
    expect(processed).toEqual([1, 2, 3, 4, 5]);
    expect(writer.nextIndex).toBe(5);
  });

  test("with a stage the overlapped runner reports its evaluations, one per source frame, not the decodes as well", async () => {
    const { params, processed } = setup(5, [passThroughStage()]);
    const result = await runOverlapped(params);
    expect(result.decoded).toBe(5);
    expect(processed).toEqual([1, 2, 3, 4, 5]);
  });

  test("and the sequential runner reports each source frame through the stage", async () => {
    const { params, processed } = setup(5, [passThroughStage()]);
    const result = await runSequential(params);
    expect(result.decoded).toBe(5);
    expect(processed).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("a cancelled run and a failing check", () => {
  test("a cancel wakes the overlapped runner from an evaluation that never settles", async () => {
    const controller = new AbortController();
    const { params } = setup(5, [hangingStage(controller)], { signal: controller.signal });
    await expect(settledInTime(runOverlapped(params))).rejects.toBeInstanceOf(JobCancelledError);
  });

  test("and the sequential runner, which races each step against the signal", async () => {
    const controller = new AbortController();
    const { params } = setup(5, [hangingStage(controller)], { signal: controller.signal });
    await expect(settledInTime(runSequential(params))).rejects.toBeInstanceOf(JobCancelledError);
  });

  test("a signal aborted before the run stops both runners before any frame", async () => {
    for (const run of [runOverlapped, runSequential]) {
      const controller = new AbortController();
      controller.abort();
      const { params, processed } = setup(5, [passThroughStage()], { signal: controller.signal });
      await expect(run(params)).rejects.toBeInstanceOf(JobCancelledError);
      expect(processed).toEqual([]);
    }
  });

  test("a check that throws ends both runners with its error, after the frame it judged", async () => {
    for (const run of [runOverlapped, runSequential]) {
      const check = (): void => {
        throw new Error("nothing generated");
      };
      const { params, processed } = setup(5, [passThroughStage()], { check });
      await expect(run(params)).rejects.toThrow("nothing generated");
      expect(processed).toEqual([1]);
    }
  });
});
