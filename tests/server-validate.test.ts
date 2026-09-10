import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS, SETTING_RANGES } from "../src/server/api-types.ts";
import { isWithin, validateJobRequest } from "../src/server/validate.ts";

const ROOT = resolve(sep === "\\" ? "C:\\app\\logs" : "/app/logs");

/** A request the server must accept, so each test can vary exactly one field. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "video",
    input: join(ROOT, "in.mp4"),
    engine: "nr",
    motion: "flow",
    settings: { ...DEFAULT_NR_SETTINGS },
    scale: { ...DEFAULT_SCALE_SETTINGS },
    ...overrides,
  };
}

describe("isWithin", () => {
  test("accepts the root itself and paths under it", () => {
    expect(isWithin(ROOT, ROOT)).toBe(true);
    expect(isWithin(join(ROOT, "out.mp4"), ROOT)).toBe(true);
    expect(isWithin(join(ROOT, "a", "b", "out.mp4"), ROOT)).toBe(true);
  });

  test("accepts a child whose name merely starts with two dots", () => {
    // The bug this covers: a string-prefix check read "..cache" as an escape.
    expect(isWithin(join(ROOT, "..cache", "out.mp4"), ROOT)).toBe(true);
    expect(isWithin(join(ROOT, "..", "logs", "..hidden.mp4"), ROOT)).toBe(true);
  });

  test("rejects escapes and sibling directories that share a prefix", () => {
    expect(isWithin(join(ROOT, "..", "etc", "passwd"), ROOT)).toBe(false);
    expect(isWithin(resolve(ROOT, ".."), ROOT)).toBe(false);
    expect(isWithin(`${ROOT}2${sep}out.mp4`, ROOT)).toBe(false);
    expect(isWithin(`${ROOT}-backup${sep}out.mp4`, ROOT)).toBe(false);
  });
});

describe("validateJobRequest", () => {
  test("accepts a well-formed request", () => {
    expect(validateJobRequest(request())).toBeNull();
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS } }))).toBeNull();
    expect(validateJobRequest(request({ frameGen: { targetFps: "120" } }))).toBeNull();
    expect(validateJobRequest(request({ frameGen: { multiplier: 2, engine: "cascade" } }))).toBeNull();
    expect(validateJobRequest(request({ dllDir: join(ROOT, "dlss", "310.7") }))).toBeNull();
  });

  test("rejects non-objects and arrays", () => {
    for (const bad of [null, 42, "x", [], undefined]) expect(validateJobRequest(bad)).toMatch(/must be a JSON object/);
  });

  test("names the offending top-level field", () => {
    expect(validateJobRequest(request({ kind: "audio" }))).toMatch(/kind must be/);
    expect(validateJobRequest(request({ input: "" }))).toMatch(/input must be/);
    expect(validateJobRequest(request({ engine: "turbo" }))).toMatch(/engine must be/);
    expect(validateJobRequest(request({ motion: "sideways" }))).toMatch(/motion must be/);
    expect(validateJobRequest(request({ dllDir: 7 }))).toMatch(/dllDir must be a string/);
    expect(validateJobRequest(request({ settings: [] }))).toMatch(/settings must be an object/);
    expect(validateJobRequest(request({ scale: "big" }))).toMatch(/scale must be an object/);
  });

  test("rejects out-of-range numbers and reports the real range", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["intensity high", { settings: { ...DEFAULT_NR_SETTINGS, intensity: 2.5 } }, /settings\.intensity must be between 0 and 2 \(got 2\.5\)/],
      ["intensity NaN", { settings: { ...DEFAULT_NR_SETTINGS, intensity: Number.NaN } }, /settings\.intensity must be a finite number between 0 and 2/],
      ["skinStructure low", { settings: { ...DEFAULT_NR_SETTINGS, skinStructure: -2 } }, /settings\.skinStructure must be between -1 and 2/],
      ["warmupFrames fractional", { settings: { ...DEFAULT_NR_SETTINGS, warmupFrames: 4.5 } }, /settings\.warmupFrames must be a whole number between 0 and 64/],
      ["warmupFrames high", { settings: { ...DEFAULT_NR_SETTINGS, warmupFrames: 65 } }, /settings\.warmupFrames must be between 0 and 64/],
      ["factor low", { scale: { ...DEFAULT_SCALE_SETTINGS, factor: 0.1 } }, /scale\.factor must be between 0\.25 and 8/],
      ["width high", { scale: { ...DEFAULT_SCALE_SETTINGS, width: 20000 } }, /scale\.width must be between 16 and 16384/],
      ["quality high", { encode: { ...DEFAULT_ENCODE_SETTINGS, quality: 60 } }, /encode\.quality must be between 0 and 51/],
    ];
    for (const [name, override, pattern] of cases) {
      const message = validateJobRequest(request(override));
      expect(message, name).toMatch(pattern);
    }
  });

  test("rejects values outside the enums", () => {
    expect(validateJobRequest(request({ settings: { ...DEFAULT_NR_SETTINGS, preset: 4 } }))).toMatch(/settings\.preset must be one of 0, 1, 2, 3/);
    expect(validateJobRequest(request({ settings: { ...DEFAULT_NR_SETTINGS, style: 3 } }))).toMatch(/settings\.style must be one of 0, 1, 2/);
    expect(validateJobRequest(request({ settings: { ...DEFAULT_NR_SETTINGS, nrPath: "driver" } }))).toMatch(/settings\.nrPath must be one of auto, core, snippet/);
    expect(validateJobRequest(request({ scale: { ...DEFAULT_SCALE_SETTINGS, mode: "stretch" } }))).toMatch(/scale\.mode must be one of none, factor, size/);
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, codec: "vp9" } }))).toMatch(/encode\.codec must be one of h264, hevc, av1/);
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, container: "avi" } }))).toMatch(/encode\.container must be one of mp4, mkv, mov/);
  });

  test("rejects non-boolean flags and a bad globalTone", () => {
    expect(validateJobRequest(request({ settings: { ...DEFAULT_NR_SETTINGS, autoMask: "yes" } }))).toMatch(/settings\.autoMask must be true or false/);
    expect(validateJobRequest(request({ settings: { ...DEFAULT_NR_SETTINGS, globalTone: "1" } }))).toMatch(/settings\.globalTone must be a finite number or null/);
    expect(validateJobRequest(request({ settings: { ...DEFAULT_NR_SETTINGS, globalTone: null } }))).toBeNull();
  });

  test("frameGen needs a rate and takes a known engine", () => {
    expect(validateJobRequest(request({ frameGen: {} }))).toMatch(/needs targetFps or multiplier/);
    expect(validateJobRequest(request({ frameGen: { multiplier: 0 } }))).toMatch(/frameGen\.multiplier must be a finite number of at least 1/);
    expect(validateJobRequest(request({ frameGen: { targetFps: 120 } }))).toMatch(/frameGen\.targetFps must be a string/);
    expect(validateJobRequest(request({ frameGen: { targetFps: "120", engine: "warp" } }))).toMatch(/frameGen\.engine must be one of auto, native, cascade/);
    expect(validateJobRequest(request({ frameGen: "fast" }))).toMatch(/frameGen must be an object/);
  });

  // A rate the planner cannot resolve used to pass validation and become a
  // queued job that failed minutes later, inside the pipeline, with a message
  // about BigInt arithmetic.
  test("frameGen.targetFps must be a rate the planner can actually resolve", () => {
    expect(validateJobRequest(request({ frameGen: { targetFps: "hello" } }))).toMatch(/not a rate this build can produce/);
    // "toString" is the prototype-chain case: it used to resolve to a function.
    expect(validateJobRequest(request({ frameGen: { targetFps: "toString" } }))).toMatch(/not a rate this build can produce/);
    expect(validateJobRequest(request({ frameGen: { targetFps: "120" } }))).toBeNull();
    expect(validateJobRequest(request({ frameGen: { targetFps: "60000/1001" } }))).toBeNull();
  });

  test("frameGen is rejected on an image job, which has no frames to interpolate", () => {
    expect(validateJobRequest(request({ kind: "image", input: "C:\\in.png", frameGen: { targetFps: "120" } }))).toMatch(/video jobs only/);
  });

  test("the defaults the server advertises are themselves valid", () => {
    // A default the API would reject would make GET /api/settings/defaults a trap.
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS } }))).toBeNull();
    for (const [field, range] of Object.entries(SETTING_RANGES)) {
      expect(range.min, `${field} range`).toBeLessThan(range.max);
    }
  });
});
