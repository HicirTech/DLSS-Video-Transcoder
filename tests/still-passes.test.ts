/**
 * runStillPasses (src/pipeline/image.ts): the passes an image job and the sr and nr commands run over a
 * still. No GPU: the pass records what it was asked.
 */
import { describe, expect, test } from "bun:test";
import { runStillPasses } from "../src/pipeline/image.ts";

async function passes(engine: "sr" | "nr" | "bypass", warmupFrames: number) {
  const resets: boolean[] = [];
  const last = await runStillPasses(engine, warmupFrames, (reset, total) => {
    resets.push(reset);
    return new Uint8Array([resets.length, total]);
  });
  return { resets, last: [...last] };
}

describe("runStillPasses", () => {
  test("a neural engine resets once, then runs warmupFrames more passes, and returns the last output", async () => {
    expect(await passes("sr", 4)).toEqual({ resets: [true, false, false, false, false], last: [5, 5] });
    expect(await passes("nr", 0)).toEqual({ resets: [true], last: [1, 1] });
  });

  test("bypass keeps no state and runs once whatever the warm-up", async () => {
    expect(await passes("bypass", 4)).toEqual({ resets: [true], last: [1, 1] });
  });
});
