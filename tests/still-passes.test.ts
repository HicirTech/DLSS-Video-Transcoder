/**
 * runStillPasses (src/pipeline/image.ts): the passes an image job and the sr and nr commands run over a
 * still. No GPU: the pass records what it was asked.
 */
import { describe, expect, test } from "bun:test";
import { runStillPasses } from "../src/pipeline/image.ts";

async function passes(temporal: boolean, warmupFrames: number) {
  const resets: boolean[] = [];
  const last = await runStillPasses(temporal, warmupFrames, (reset, total) => {
    resets.push(reset);
    return new Uint8Array([resets.length, total]);
  });
  return { resets, last: [...last] };
}

describe("runStillPasses", () => {
  test("a temporal engine resets once, then runs warmupFrames more passes, and returns the last output", async () => {
    expect(await passes(true, 4)).toEqual({ resets: [true, false, false, false, false], last: [5, 5] });
    expect(await passes(true, 0)).toEqual({ resets: [true], last: [1, 1] });
  });

  test("the copy a job without steps runs keeps no state and runs once whatever the warm-up", async () => {
    expect(await passes(false, 4)).toEqual({ resets: [true], last: [1, 1] });
  });
});
