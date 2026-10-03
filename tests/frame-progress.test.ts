import { expect, test } from "bun:test";
import { frameProgress } from "../src/pipeline/frame-progress.ts";

test("progress follows the frames written and names them", () => {
  expect(frameProgress(50, 200)).toEqual({ fraction: 0.25, message: "frame 50/200" });
  expect(frameProgress(0, 200)).toEqual({ fraction: 0, message: "frame 0/200" });
});

test("the bar never reaches 1 while frames are still being written, even when the count overshoots", () => {
  expect(frameProgress(199, 200).fraction).toBe(0.98);
  expect(frameProgress(250, 200).fraction).toBe(0.98);
});

test("without a frame total it reads halfway and shows a question mark", () => {
  expect(frameProgress(7, null)).toEqual({ fraction: 0.5, message: "frame 7/?" });
});
