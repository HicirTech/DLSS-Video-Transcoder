/**
 * The frame-generation runners (src/pipeline/framegen-run.ts) over a stand-in decoder pipe and
 * stages: which frames they report as processed, so the job's progress moves for every plan.
 */
import { describe, expect, test } from "bun:test";
import { FrameReader } from "../src/pipeline/frame-reader.ts";
import { NearestTimestampWriter } from "../src/pipeline/framegen-plan.ts";
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
    prepare: async (frame: AnalyzedFrame["frame"]): Promise<AnalyzedFrame> => ({ frame, previousTimestamp: null, reset: true, small: null, half: null }),
    pack: async (analyzed: AnalyzedFrame): Promise<PreparedFrame> => ({ frame: analyzed.frame, previousTimestamp: null, half: null, reset: true }),
    evaluate: async (prepared: PreparedFrame) => [prepared.frame],
  };
  return stage as unknown as Stage;
}

function setup(frames: number, stages: Stage[]) {
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
});
