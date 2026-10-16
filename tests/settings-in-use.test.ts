/**
 * settings-in-use.ts: which settings a job uses, as the web forms show it and the server checks a dllDir
 * against it. Pure; no GPU.
 */
import { describe, expect, test } from "bun:test";
import { ENGINE_KINDS, ENGINE_USES_MOTION, FRAME_GEN_GPU_CHOICE } from "../src/server/api-types.ts";
import { dllFeatureOf, jobShapeOf, unusedSettings } from "../src/server/settings-in-use.ts";

describe("jobShapeOf", () => {
  test("a request runs frame generation exactly when it carries frameGen", () => {
    expect(jobShapeOf({ engine: "sr", frameGen: { targetFps: "60" } })).toEqual({ engine: "sr", frameGen: true });
    expect(jobShapeOf({ engine: "nr" })).toEqual({ engine: "nr", frameGen: false });
  });
});

describe("dllFeatureOf", () => {
  test("a frame generation job loads DLSS Frame Generation whatever its engine; otherwise the engine says, and bypass loads nothing", () => {
    for (const engine of ENGINE_KINDS) expect(dllFeatureOf({ engine, frameGen: true }), engine).toBe("fg");
    expect(dllFeatureOf({ engine: "sr", frameGen: false })).toBe("sr");
    expect(dllFeatureOf({ engine: "nr", frameGen: false })).toBe("nr");
    expect(dllFeatureOf({ engine: "bypass", frameGen: false })).toBeNull();
  });
});

describe("unusedSettings", () => {
  test("frame generation uses none of the per-frame settings, nor the stored GPU, whatever the engine", () => {
    for (const engine of ENGINE_KINDS) {
      const unused = unusedSettings({ engine, frameGen: true });
      for (const group of ["engine", "motion", "outputSize", "nrLook"] as const) expect(unused[group], `${engine} ${group}`).toContain("Frame generation only interpolates");
      expect(unused.gpu, engine).toBe(`Frame generation picks its GPU itself: ${FRAME_GEN_GPU_CHOICE}.`);
    }
  });

  test("without frame generation the engine and the output size always apply, and so does the stored GPU", () => {
    for (const engine of ENGINE_KINDS) {
      const unused = unusedSettings({ engine, frameGen: false });
      expect([unused.engine, unused.outputSize, unused.gpu], engine).toEqual([null, null, null]);
    }
  });

  test("motion applies to exactly the engines ENGINE_USES_MOTION names, and the reason names the engine", () => {
    for (const engine of ENGINE_KINDS) {
      const reason = unusedSettings({ engine, frameGen: false }).motion;
      if (ENGINE_USES_MOTION[engine]) expect(reason, engine).toBeNull();
      else expect(reason, engine).toMatch(/takes no motion vectors\.$/);
    }
    expect(unusedSettings({ engine: "bypass", frameGen: false }).motion).toBe("The bypass engine takes no motion vectors.");
  });

  test("the look settings apply to nr alone, and the reason says what the other engine does instead", () => {
    expect(unusedSettings({ engine: "nr", frameGen: false }).nrLook).toBeNull();
    expect(unusedSettings({ engine: "sr", frameGen: false }).nrLook).toBe("Super Resolution has no look settings: it upscales to the output size.");
    expect(unusedSettings({ engine: "bypass", frameGen: false }).nrLook).toBe("The bypass engine copies frames unchanged, so no look setting applies.");
  });
});
