import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultOutputPath } from "../src/pipeline/output-path.ts";

test("the output sits next to the input, named stem.suffix.extension", () => {
  const folder = join("some", "clips");
  expect(defaultOutputPath(join(folder, "holiday.mp4"), "nr", ".mkv")).toBe(join(folder, "holiday.nr.mkv"));
  expect(defaultOutputPath(join(folder, "photo.png"), "sr", ".png")).toBe(join(folder, "photo.sr.png"));
});

test("only the last extension of the input is replaced, and an input without one keeps its whole name", () => {
  const folder = join("some", "clips");
  expect(defaultOutputPath(join(folder, "take.2.final.mov"), "bypass", ".mp4")).toBe(join(folder, "take.2.final.bypass.mp4"));
  expect(defaultOutputPath(join(folder, "raw"), "dlssg", ".mp4")).toBe(join(folder, "raw.dlssg.mp4"));
});
