/**
 * settings-in-use.ts: which DLSS feature a job loads, the one the server checks a dllDir against. Pure; no GPU.
 */
import { describe, expect, test } from "bun:test";
import { ENGINE_KINDS } from "../src/server/api-types.ts";
import { dllFeatureOf, jobShapeOf } from "../src/server/settings-in-use.ts";

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
