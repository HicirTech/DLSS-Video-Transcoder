import { expect, test } from "bun:test";
import { estimatedFrameProgress, frameProgress } from "../src/pipeline/frame-progress.ts";

test("progress follows the frames written and names them", () => {
  expect(frameProgress(50, 200)).toEqual({ fraction: 0.25, message: "frame 50/200", frames: { done: 50, total: 200 } });
  expect(frameProgress(0, 200)).toEqual({ fraction: 0, message: "frame 0/200", frames: { done: 0, total: 200 } });
});

test("the bar never reaches 1 while frames are still being written, even when the count overshoots", () => {
  expect(frameProgress(199, 200).fraction).toBe(0.98);
  expect(frameProgress(250, 200).fraction).toBe(0.98);
});

test("without a frame total it reads halfway, shows a question mark and counts against no total", () => {
  expect(frameProgress(7, null)).toEqual({ fraction: 0.5, message: "frame 7/?", frames: { done: 7, total: null } });
});

test("frame generation counts source frames against its estimate, and the line says it is one", () => {
  const report = estimatedFrameProgress(466, 3733);
  expect(report.message).toBe("frame 466/~3733");
  expect(report.frames).toEqual({ done: 466, total: 3733 });
  expect(report.fraction).toBeCloseTo(466 / 3733, 12);
});

test("frame generation's bar stops short of the reports that follow the stream, even when the count passes the estimate", () => {
  expect(estimatedFrameProgress(3733, 3733).fraction).toBe(0.96);
  expect(estimatedFrameProgress(3734, 3733)).toEqual({ fraction: 0.96, message: "frame 3734/~3733", frames: { done: 3734, total: 3733 } });
});

// The line and the count are built together so that they cannot disagree; this is the check that they do not.
test("the numbers in every producer's line are the counts it reports", () => {
  for (const report of [frameProgress(50, 200), frameProgress(7, null), estimatedFrameProgress(466, 3733)]) {
    const line = /^frame (\d+)\/~?(\d+|\?)$/.exec(report.message);
    expect(line, report.message).not.toBeNull();
    expect(Number(line![1])).toBe(report.frames.done);
    expect(line![2] === "?" ? null : Number(line![2])).toBe(report.frames.total);
  }
});
