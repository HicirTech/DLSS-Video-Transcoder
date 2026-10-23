import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { defaultOutputPath, inputAsOutputProblem } from "../src/pipeline/output-path.ts";

test("the output sits next to the input, named stem.suffix.extension", () => {
  const folder = join("some", "clips");
  expect(defaultOutputPath(join(folder, "holiday.mp4"), "nr", ".mkv")).toBe(join(folder, "holiday.nr.mkv"));
  expect(defaultOutputPath(join(folder, "photo.png"), "sr", ".png")).toBe(join(folder, "photo.sr.png"));
});

test("only the last extension of the input is replaced, and an input without one keeps its whole name", () => {
  const folder = join("some", "clips");
  expect(defaultOutputPath(join(folder, "take.2.final.mov"), "copy", ".mp4")).toBe(join(folder, "take.2.final.copy.mp4"));
  expect(defaultOutputPath(join(folder, "raw"), "fg", ".mp4")).toBe(join(folder, "raw.fg.mp4"));
});

test("an output that names the input is refused, however the path is spelled", () => {
  const input = resolve("some", "clips", "holiday.mp4");
  for (const output of [input, input.toUpperCase(), resolve("some", "clips", "..", "clips", "holiday.mp4"), input.replaceAll("\\", "/")]) {
    expect(inputAsOutputProblem(input, output)).toContain("is the input file itself");
  }
});

test("an output next to the input, or the default name, is accepted", () => {
  const input = resolve("some", "clips", "holiday.mp4");
  expect(inputAsOutputProblem(input, resolve("some", "clips", "holiday.copy.mp4"))).toBeNull();
  expect(inputAsOutputProblem(input, defaultOutputPath(input, "nr", ".mp4"))).toBeNull();
});
