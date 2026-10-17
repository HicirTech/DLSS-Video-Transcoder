/**
 * settings-in-use.ts: which settings outside the step cards a job uses, as the web forms show it, and whether it
 * takes the GPU choice, as the server checks it. Pure; no GPU.
 */
import { describe, expect, test } from "bun:test";
import { FRAME_GEN_GPU_CHOICE } from "../src/server/api-types.ts";
import { type JobShape, takesGpuChoice, unusedSettings } from "../src/server/settings-in-use.ts";

/** Every combination of the three steps. */
const SHAPES: JobShape[] = Array.from({ length: 8 }, (_, mask) => ({ sr: Boolean(mask & 1), nr: Boolean(mask & 2), fg: Boolean(mask & 4) }));

const label = (job: JobShape): string => Object.entries(job).filter(([, on]) => on).map(([step]) => step).join("+") || "none";

describe("takesGpuChoice", () => {
  test("every job takes the GPU choice except one that runs frame generation alone", () => {
    for (const job of SHAPES) expect(takesGpuChoice(job), label(job)).toBe(!(job.fg && !job.sr && !job.nr));
  });
});

describe("unusedSettings", () => {
  test("the resize applies exactly when Super Resolution is off, which sets the size itself", () => {
    for (const job of SHAPES) expect(unusedSettings(job).resize, label(job)).toBe(job.sr ? "Super Resolution sets the output size." : null);
  });

  test("the GPU note appears only with frame generation, and says what still takes the choice", () => {
    for (const job of SHAPES) if (!job.fg) expect(unusedSettings(job).gpu, label(job)).toBeNull();
    expect(unusedSettings({ sr: false, nr: false, fg: true }).gpu).toBe(`Frame generation picks its GPU itself: ${FRAME_GEN_GPU_CHOICE}.`);
    expect(unusedSettings({ sr: true, nr: false, fg: true }).gpu).toBe(
      `Super Resolution and Neural Rendering run on the GPU chosen in Settings. Frame generation picks its GPU itself: ${FRAME_GEN_GPU_CHOICE}.`,
    );
  });
});
