/** The settings contract the CLI help, the web editors and the API validation all read from api-types.ts. */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_FRAME_GEN_MULTIPLIER,
  DEFAULT_FRAME_GEN_STEP,
  DEFAULT_NR_SETTINGS,
  DEFAULT_NR_STACK,
  DEFAULT_SCALE_SETTINGS,
  DEFAULT_SR_STEP,
  DEFAULT_WARMUP_FRAMES,
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  FRAME_GEN_ENGINES,
  MOTION_KINDS,
  NR_INTENSITY_EFFECTIVE_MAX,
  NR_PRESETS,
  NR_STYLES,
  NR_STYLE_LABELS,
  SCALE_MODES,
  SETTING_RANGES,
  SR_FACTOR_MIN,
  type JobState,
  clampToRange,
  isActiveState,
  isTerminalState,
  jobSteps,
  nrStackLabel,
  nrStackOf,
  resizesFrames,
  stepsSuffix,
} from "../src/server/api-types.ts";
import { resolveTargetRate } from "../src/pipeline/framegen-plan.ts";

describe("defaults", () => {
  // Listing every ranged field here is the point: a new range without a default fails to compile.
  const numericDefaults = {
    intensity: DEFAULT_NR_SETTINGS.intensity,
    localTone: DEFAULT_NR_SETTINGS.localTone,
    localStructure: DEFAULT_NR_SETTINGS.localStructure,
    skinStructure: DEFAULT_NR_SETTINGS.skinStructure,
    stack: DEFAULT_NR_STACK,
    warmupFrames: DEFAULT_WARMUP_FRAMES,
    factor: DEFAULT_SCALE_SETTINGS.factor,
    width: DEFAULT_SCALE_SETTINGS.width,
    height: DEFAULT_SCALE_SETTINGS.height,
    quality: DEFAULT_ENCODE_SETTINGS.quality,
    multiplier: DEFAULT_FRAME_GEN_MULTIPLIER,
  } satisfies Record<keyof typeof SETTING_RANGES, number>;

  test("every numeric default sits inside the range the API enforces", () => {
    for (const [field, value] of Object.entries(numericDefaults)) {
      const range = SETTING_RANGES[field as keyof typeof SETTING_RANGES];
      expect(value, field).toBeGreaterThanOrEqual(range.min);
      expect(value, field).toBeLessThanOrEqual(range.max);
      if (range.integer) expect(Number.isInteger(value), field).toBe(true);
    }
  });

  test("the default intensity is one the installed runtime still responds to", () => {
    expect(DEFAULT_NR_SETTINGS.intensity).toBeLessThanOrEqual(NR_INTENSITY_EFFECTIVE_MAX);
  });

  test("every default choice is one the API accepts", () => {
    expect(NR_PRESETS).toContain(DEFAULT_NR_SETTINGS.preset);
    expect(NR_STYLES).toContain(DEFAULT_NR_SETTINGS.style);
    expect(SCALE_MODES).toContain(DEFAULT_SCALE_SETTINGS.mode);
    expect(ENCODE_CODECS).toContain(DEFAULT_ENCODE_SETTINGS.codec);
    expect(ENCODE_CONTAINERS).toContain(DEFAULT_ENCODE_SETTINGS.container);
    expect(MOTION_KINDS).toContain(DEFAULT_SR_STEP.motion);
    expect(FRAME_GEN_ENGINES).toContain(DEFAULT_FRAME_GEN_STEP.engine);
  });

  test("a Super Resolution step starts at a size Super Resolution writes, and frame generation at a rate the planner has", () => {
    expect(DEFAULT_SR_STEP.scale.mode).toBe("factor");
    expect(DEFAULT_SR_STEP.scale.factor).toBeGreaterThanOrEqual(SR_FACTOR_MIN);
    expect(() => resolveTargetRate(DEFAULT_FRAME_GEN_STEP.targetFps)).not.toThrow();
  });
});

describe("steps", () => {
  test("jobSteps lists the steps a request carries in the order they run, whatever order the fields come in", () => {
    const fg = { targetFps: "60" };
    const sr = { scale: DEFAULT_SR_STEP.scale };
    const nr = { settings: DEFAULT_NR_SETTINGS };
    expect(jobSteps({ frameGen: fg, neuralRendering: nr, superResolution: sr })).toEqual(["sr", "nr", "fg"]);
    expect(jobSteps({ frameGen: fg, superResolution: sr })).toEqual(["sr", "fg"]);
    expect(jobSteps({})).toEqual([]);
  });

  test("a default output is named after the steps, a resize alone, or a copy", () => {
    expect(stepsSuffix(["sr", "nr", "fg"], false, 1)).toBe("sr-nr-fg");
    expect(stepsSuffix(["nr"], true, 1)).toBe("nr");
    expect(stepsSuffix([], true, 1)).toBe("resize");
    expect(stepsSuffix([], false, 1)).toBe("copy");
  });

  test("a stacked Neural Rendering names its pass count, and only Neural Rendering's name changes", () => {
    expect(stepsSuffix(["sr", "nr", "fg"], false, 3)).toBe("sr-nrx3-fg");
    expect(stepsSuffix(["sr", "fg"], false, 3)).toBe("sr-fg");
    expect(nrStackLabel(1)).toBe("nr");
    expect(nrStackLabel(4)).toBe("nrx4");
  });

  test("a Neural Rendering step without a stack runs once", () => {
    expect(nrStackOf({ settings: DEFAULT_NR_SETTINGS })).toBe(DEFAULT_NR_STACK);
    expect(nrStackOf({ settings: DEFAULT_NR_SETTINGS, stack: 3 })).toBe(3);
    expect(nrStackOf(undefined)).toBe(DEFAULT_NR_STACK);
  });

  test("a job resizes its frames only with a factor or size resize and no Super Resolution", () => {
    const factor = { ...DEFAULT_SCALE_SETTINGS, mode: "factor" as const, factor: 1.5 };
    expect(resizesFrames({ resize: factor })).toBe(true);
    expect(resizesFrames({ resize: { ...DEFAULT_SCALE_SETTINGS, mode: "size" as const, width: 1280, height: 720 } })).toBe(true);
    expect(resizesFrames({ superResolution: DEFAULT_SR_STEP, resize: factor })).toBe(false);
    expect(resizesFrames({ resize: { ...DEFAULT_SCALE_SETTINGS, mode: "none" as const } })).toBe(false);
    expect(resizesFrames({})).toBe(false);
  });
});

describe("labels", () => {
  test("every look style has words, and nothing else does", () => {
    expect(Object.keys(NR_STYLE_LABELS).map(Number)).toEqual([...NR_STYLES]);
    for (const style of NR_STYLES) expect(NR_STYLE_LABELS[style], String(style)).not.toBe("");
  });
});

describe("job states", () => {
  // Typed as a Record so that a new state fails to compile here until it is classified.
  const active: Record<JobState, boolean> = { queued: true, running: true, done: false, failed: false, cancelled: false };

  test("a job that is still queued or running is active, and one that has ended is not", () => {
    for (const [state, expected] of Object.entries(active) as Array<[JobState, boolean]>) expect(isActiveState(state), state).toBe(expected);
  });

  test("every state is exactly one of active and terminal", () => {
    for (const state of Object.keys(active) as JobState[]) expect(isTerminalState(state), state).toBe(!isActiveState(state));
  });
});

describe("clampToRange", () => {
  const { quality, skinStructure, factor } = SETTING_RANGES;

  test("holds a value inside the range of its setting", () => {
    expect(clampToRange("quality", quality.min - 1)).toBe(quality.min);
    expect(clampToRange("quality", quality.max + 1)).toBe(quality.max);
    expect(clampToRange("quality", 18)).toBe(18);
    expect(clampToRange("skinStructure", skinStructure.min - 1)).toBe(skinStructure.min);
    expect(clampToRange("factor", factor.max + 1)).toBe(factor.max);
  });

  test("rounds a whole-number setting first and leaves a fractional one alone", () => {
    expect(clampToRange("quality", 20.6)).toBe(21);
    expect(clampToRange("quality", quality.max + 0.4)).toBe(quality.max);
    expect(clampToRange("factor", 1.375)).toBe(1.375);
  });
});
