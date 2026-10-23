import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import {
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_FRAME_GEN_STEP,
  DEFAULT_NR_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
  DEFAULT_SR_STEP,
  DEFAULT_WARMUP_FRAMES,
  JOB_KINDS,
  MOTION_KINDS,
  SETTING_RANGES,
} from "../src/server/api-types.ts";
import { validateJobRequest } from "../src/server/validate.ts";

const ROOT = resolve(sep === "\\" ? "C:\\app\\logs" : "/app/logs");
const UUID = "GPU-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2";

const sr = (overrides: Record<string, unknown> = {}) => ({ scale: { ...DEFAULT_SR_STEP.scale }, motion: "flow", ...overrides });
const nr = (overrides: Record<string, unknown> = {}) => ({ settings: { ...DEFAULT_NR_SETTINGS, ...overrides } });

/** A video request the server must accept, so each test can vary exactly one field. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "video", input: join(ROOT, "in.mp4"), superResolution: sr(), neuralRendering: nr(), ...overrides };
}

describe("validateJobRequest", () => {
  test("accepts a well-formed request", () => {
    expect(validateJobRequest(request())).toBeNull();
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS } }))).toBeNull();
    expect(validateJobRequest(request({ frameGen: { targetFps: "120" } }))).toBeNull();
    expect(validateJobRequest(request({ frameGen: { multiplier: 2, engine: "cascade" } }))).toBeNull();
    expect(validateJobRequest(request({ superResolution: sr({ dllDir: join(ROOT, "dlss", "310.7") }) }))).toBeNull();
  });

  test("rejects non-objects and arrays", () => {
    for (const bad of [null, 42, "x", [], undefined]) expect(validateJobRequest(bad)).toMatch(/must be a JSON object/);
  });

  test("accepts every kind and motion the contract lists, and any set of steps", () => {
    for (const kind of JOB_KINDS) expect(validateJobRequest({ kind, input: join(ROOT, "in.png") }), kind).toBeNull();
    for (const motion of MOTION_KINDS) expect(validateJobRequest(request({ superResolution: sr({ motion }) })), motion).toBeNull();
    const steps = { superResolution: sr(), neuralRendering: nr(), frameGen: { targetFps: "60" } };
    for (let mask = 0; mask < 8; mask++) {
      const chosen = Object.fromEntries(Object.entries(steps).filter((_, index) => mask & (1 << index)));
      expect(validateJobRequest({ kind: "video", input: join(ROOT, "in.mp4"), ...chosen }), Object.keys(chosen).join("+") || "none").toBeNull();
    }
  });

  test("names the offending top-level field", () => {
    expect(validateJobRequest(request({ kind: "audio" }))).toMatch(/kind must be one of image, video \(got "audio"\)/);
    expect(validateJobRequest(request({ input: "" }))).toMatch(/input must be/);
    expect(validateJobRequest(request({ superResolution: "big" }))).toBe("superResolution must be an object when present.");
    expect(validateJobRequest(request({ neuralRendering: [] }))).toBe("neuralRendering must be an object when present.");
    expect(validateJobRequest(request({ superResolution: sr({ motion: "sideways" }) }))).toMatch(/superResolution\.motion must be one of none, flow \(got "sideways"\)/);
    expect(validateJobRequest(request({ neuralRendering: { settings: [] } }))).toMatch(/neuralRendering\.settings must be an object/);
    expect(validateJobRequest(request({ superResolution: { scale: "big" } }))).toMatch(/superResolution\.scale must be an object/);
    for (const step of ["superResolution", "neuralRendering"]) {
      const value = request()[step] as Record<string, unknown>;
      expect(validateJobRequest(request({ [step]: { ...value, dllDir: 7 } })), step).toBe(`${step}.dllDir must be a string when present.`);
    }
    expect(validateJobRequest(request({ frameGen: { targetFps: "60", dllDir: 7 } }))).toBe("frameGen.dllDir must be a string when present.");
  });

  test("the fields the step objects replaced are refused by name, so an old client is not run as a different job", () => {
    expect(validateJobRequest(request({ engine: "nr" }))).toBe(
      "engine is no longer part of a job: give each step its own object (superResolution, neuralRendering, frameGen) and resize for a plain resize.",
    );
    expect(validateJobRequest(request({ scale: { ...DEFAULT_SCALE_SETTINGS }, settings: { ...DEFAULT_NR_SETTINGS } }))).toMatch(/^scale, settings are no longer part of a job/);
  });

  test("accepts each numeric limit and rejects one step past it, reporting the real range", () => {
    const cases: Array<[keyof typeof SETTING_RANGES, string, (value: number) => Record<string, unknown>, "min" | "max"]> = [
      ["intensity", "neuralRendering.settings.intensity", (value) => ({ neuralRendering: nr({ intensity: value }) }), "max"],
      ["skinStructure", "neuralRendering.settings.skinStructure", (value) => ({ neuralRendering: nr({ skinStructure: value }) }), "min"],
      ["factor", "superResolution.scale.factor", (value) => ({ superResolution: sr({ scale: { ...DEFAULT_SR_STEP.scale, factor: value } }) }), "max"],
      // On a resize, not Super Resolution, which holds a side to DLSS_SR_MAX_OUTPUT_SIDE.
      ["width", "resize.width", (value) => ({ superResolution: undefined, resize: { ...DEFAULT_SCALE_SETTINGS, width: value } }), "max"],
      ["quality", "encode.quality", (value) => ({ encode: { ...DEFAULT_ENCODE_SETTINGS, quality: value } }), "max"],
    ];
    for (const [field, path, build, side] of cases) {
      const { min, max } = SETTING_RANGES[field];
      const limit = side === "max" ? max : min;
      const outside = side === "max" ? max + 1 : min - 1;
      expect(validateJobRequest(request(build(limit))), `${field} at ${limit}`).toBeNull();
      expect(validateJobRequest(request(build(outside))), `${field} at ${outside}`).toBe(`${path} must be between ${min} and ${max} (got ${outside}).`);
    }
    const intensity = SETTING_RANGES.intensity;
    expect(validateJobRequest(request({ neuralRendering: nr({ intensity: Number.NaN }) }))).toBe(
      `neuralRendering.settings.intensity must be a finite number between ${intensity.min} and ${intensity.max}.`,
    );
  });

  test("rejects values outside the enums", () => {
    expect(validateJobRequest(request({ neuralRendering: nr({ preset: 4 }) }))).toMatch(/neuralRendering\.settings\.preset must be one of 0, 1, 2, 3/);
    expect(validateJobRequest(request({ neuralRendering: nr({ style: 3 }) }))).toMatch(/neuralRendering\.settings\.style must be one of 0, 1, 2/);
    expect(validateJobRequest(request({ superResolution: sr({ scale: { ...DEFAULT_SR_STEP.scale, mode: "stretch" } }) }))).toMatch(/superResolution\.scale\.mode must be one of none, factor, size/);
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, codec: "vp9" } }))).toMatch(/encode\.codec must be one of h264, hevc, av1/);
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, container: "avi" } }))).toMatch(/encode\.container must be one of mp4, mkv, mov/);
  });

  test("rejects non-boolean flags", () => {
    expect(validateJobRequest(request({ neuralRendering: nr({ autoMask: "yes" }) }))).toMatch(/neuralRendering\.settings\.autoMask must be true or false/);
  });

  test("accepts a CUDA device UUID in nvidia-smi's form and rejects anything else", () => {
    expect(validateJobRequest(request({ adapterUuid: UUID }))).toBeNull();
    for (const bad of ["gpu-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2", "524e8373-5fe1-44b3-c0aa-cdbe917e7ed2", "GPU-524e837-5fe1-44b3-c0aa-cdbe917e7ed2", "0", 7]) {
      expect(validateJobRequest(request({ adapterUuid: bad }))).toMatch(/adapterUuid must be a CUDA device UUID/);
    }
  });

  test("a GPU choice reaches Super Resolution, Neural Rendering and a plain copy, so frame generation alone refuses it", () => {
    const frameGen = { targetFps: "120" };
    expect(validateJobRequest({ kind: "video", input: join(ROOT, "in.mp4"), frameGen, adapterUuid: UUID })).toMatch(
      /^adapterUuid applies to Super Resolution and Neural Rendering; frame generation picks its GPU itself/,
    );
    expect(validateJobRequest({ kind: "video", input: join(ROOT, "in.mp4"), frameGen })).toBeNull();
    expect(validateJobRequest(request({ superResolution: undefined, frameGen, adapterUuid: UUID }))).toBeNull();
    expect(validateJobRequest({ kind: "video", input: join(ROOT, "in.mp4"), adapterUuid: UUID })).toBeNull();
  });

  test("frameGen needs a rate and takes a known engine", () => {
    expect(validateJobRequest(request({ frameGen: {} }))).toMatch(/needs targetFps or multiplier/);
    expect(validateJobRequest(request({ frameGen: { multiplier: 0 } }))).toBe("frameGen.multiplier must be between 1 and 16 (got 0).");
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

  test("frameGen.multiplier is a whole number from 1 to 16, the range the CLI takes", () => {
    expect(validateJobRequest(request({ frameGen: { multiplier: 2.5 } }))).toBe("frameGen.multiplier must be a whole number between 1 and 16.");
    expect(validateJobRequest(request({ frameGen: { multiplier: 17 } }))).toBe("frameGen.multiplier must be between 1 and 16 (got 17).");
    expect(validateJobRequest(request({ frameGen: { multiplier: 16 } }))).toBeNull();
    expect(validateJobRequest(request({ frameGen: { multiplier: 1 } }))).toBeNull();
  });

  test("frameGen writes mp4 only, so another container or output extension is refused", () => {
    const frameGen = { targetFps: "120" };
    expect(validateJobRequest(request({ frameGen, encode: { ...DEFAULT_ENCODE_SETTINGS, container: "mkv" } }))).toBe(
      'Frame generation writes mp4 only; set encode.container to "mp4" (got "mkv").',
    );
    expect(validateJobRequest(request({ frameGen, output: join(ROOT, "out.mov") }))).toBe(
      "Frame generation writes mp4 only; give the output path a .mp4 extension or omit it.",
    );
    expect(validateJobRequest(request({ frameGen, encode: { ...DEFAULT_ENCODE_SETTINGS }, output: join(ROOT, "out.MP4") }))).toBeNull();
    // Without frame generation the container stays free.
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, container: "mkv" }, output: join(ROOT, "out.mkv") }))).toBeNull();
  });

  test("an explicit output ends in the extension of what the job writes, whatever its case", () => {
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, container: "mkv" }, output: join(ROOT, "out.mp4") }))).toBe(
      "output must end in .mkv, the encode.container this job writes; rename it or set encode.container to match.",
    );
    expect(validateJobRequest(request({ output: join(ROOT, "out.mkv") }))).toBe(
      "output must end in .mp4, the encode.container this job writes; rename it or set encode.container to match.",
    );
    expect(validateJobRequest({ kind: "image", input: join(ROOT, "in.png"), output: join(ROOT, "out.jpg") })).toBe(
      "output must end in .png: an image job writes PNG; rename it or omit it.",
    );
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, container: "mkv" }, output: join(ROOT, "out.MKV") }))).toBeNull();
    expect(validateJobRequest(request({ output: join(ROOT, "out.mp4") }))).toBeNull();
    expect(validateJobRequest({ kind: "image", input: join(ROOT, "in.png"), output: join(ROOT, "out.PNG") })).toBeNull();
  });

  test("an unknown container is reported as one, not as a wrong extension", () => {
    expect(validateJobRequest(request({ encode: { ...DEFAULT_ENCODE_SETTINGS, container: "avi" }, output: join(ROOT, "out.avi") }))).toBe(
      'encode.container must be one of mp4, mkv, mov (got "avi").',
    );
  });

  test("Super Resolution takes a factor of at least 1 and an exact size of at most 8192 per side, since DLSS SR only enlarges", () => {
    const shrink = { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 0.5 };
    expect(validateJobRequest(request({ superResolution: sr({ scale: shrink }) }))).toBe(
      "Super Resolution only enlarges: superResolution.scale.factor must be at least 1 (got 0.5; 1 runs DLAA at the source size). Use resize without superResolution to shrink.",
    );
    expect(validateJobRequest(request({ superResolution: sr({ scale: { ...shrink, factor: 1 } }) }))).toBeNull();
    expect(validateJobRequest(request({ superResolution: sr({ scale: { ...DEFAULT_SCALE_SETTINGS, mode: "size", width: 8194, height: 4096 } }) }))).toBe(
      "DLSS Super Resolution writes at most 8192 pixels per side; 8194x4096 is larger. Use a smaller factor or output size.",
    );
    // Without Super Resolution, a resize shrinks through ffmpeg.
    expect(validateJobRequest(request({ superResolution: undefined, resize: shrink }))).toBeNull();
  });

  test("a resize is refused beside Super Resolution, which sets the output size itself", () => {
    expect(validateJobRequest(request({ resize: { ...DEFAULT_SCALE_SETTINGS, mode: "factor" } }))).toBe(
      "resize does not apply with superResolution, which sets the output size itself; omit it.",
    );
  });

  test("an image job takes no motion, frame generation or encode settings, and only it takes warm-up passes", () => {
    const image = { kind: "image", input: join(ROOT, "in.png") };
    expect(validateJobRequest({ ...image, superResolution: sr({ motion: "flow" }) })).toBe('superResolution.motion applies to video jobs only; omit it or set it to "none".');
    expect(validateJobRequest({ ...image, superResolution: sr({ motion: "none" }), warmupFrames: 8 })).toBeNull();
    expect(validateJobRequest({ ...image, frameGen: { targetFps: "120" } })).toMatch(/video jobs only/);
    expect(validateJobRequest({ ...image, encode: { ...DEFAULT_ENCODE_SETTINGS } })).toBe("encode applies to video jobs only.");
    expect(validateJobRequest({ ...image, warmupFrames: 4.5 })).toBe("warmupFrames must be a whole number between 0 and 64.");
    expect(validateJobRequest({ ...image, warmupFrames: 65 })).toBe("warmupFrames must be between 0 and 64 (got 65).");
    expect(validateJobRequest(request({ warmupFrames: 4 }))).toBe("warmupFrames applies to image jobs only.");
  });

  test("the defaults the server advertises are themselves valid", () => {
    // A default the API would reject would make GET /api/settings/defaults a trap.
    expect(validateJobRequest(request({ superResolution: { ...DEFAULT_SR_STEP }, encode: { ...DEFAULT_ENCODE_SETTINGS }, frameGen: { ...DEFAULT_FRAME_GEN_STEP } }))).toBeNull();
    expect(validateJobRequest(request({ superResolution: undefined, resize: { ...DEFAULT_SCALE_SETTINGS } }))).toBeNull();
    expect(
      validateJobRequest({ kind: "image", input: join(ROOT, "in.png"), superResolution: { ...DEFAULT_SR_STEP }, neuralRendering: nr(), warmupFrames: DEFAULT_WARMUP_FRAMES }),
    ).toBeNull();
  });
});
