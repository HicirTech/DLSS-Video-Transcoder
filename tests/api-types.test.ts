/** The settings contract the CLI help, the web editors and the API validation all read from api-types.ts. */
import { describe, expect, test } from "bun:test";
import {
  ACTIVE_JOB_STATES,
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_NR_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  NR_INTENSITY_EFFECTIVE_MAX,
  NR_PRESETS,
  NR_STYLES,
  NR_STYLE_LABELS,
  SCALE_MODES,
  SETTING_RANGES,
  TERMINAL_JOB_STATES,
  clampToRange,
  isActiveState,
  isTerminalState,
} from "../src/server/api-types.ts";

describe("defaults", () => {
  // Listing every ranged field here is the point: a new range without a default fails to compile.
  const numericDefaults = {
    intensity: DEFAULT_NR_SETTINGS.intensity,
    localTone: DEFAULT_NR_SETTINGS.localTone,
    localStructure: DEFAULT_NR_SETTINGS.localStructure,
    skinStructure: DEFAULT_NR_SETTINGS.skinStructure,
    warmupFrames: DEFAULT_NR_SETTINGS.warmupFrames,
    factor: DEFAULT_SCALE_SETTINGS.factor,
    width: DEFAULT_SCALE_SETTINGS.width,
    height: DEFAULT_SCALE_SETTINGS.height,
    quality: DEFAULT_ENCODE_SETTINGS.quality,
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
  });
});

describe("labels", () => {
  test("every look style has words, and nothing else does", () => {
    expect(Object.keys(NR_STYLE_LABELS).map(Number)).toEqual([...NR_STYLES]);
    for (const style of NR_STYLES) expect(NR_STYLE_LABELS[style], String(style)).not.toBe("");
  });
});

describe("job states", () => {
  test("every state is exactly one of active and terminal", () => {
    const states = [...ACTIVE_JOB_STATES, ...TERMINAL_JOB_STATES];
    expect(new Set(states).size).toBe(states.length);
    for (const state of states) expect(isActiveState(state), state).toBe(!isTerminalState(state));
  });

  test("a job that is still queued or running is active, and one that has ended is not", () => {
    for (const state of ["queued", "running"] as const) expect(isActiveState(state), state).toBe(true);
    for (const state of ["done", "failed", "cancelled"] as const) expect(isActiveState(state), state).toBe(false);
  });
});

describe("clampToRange", () => {
  test("holds a value inside the range of its setting", () => {
    expect(clampToRange("quality", -3)).toBe(0);
    expect(clampToRange("quality", 99)).toBe(51);
    expect(clampToRange("quality", 18)).toBe(18);
    expect(clampToRange("skinStructure", -5)).toBe(-1);
    expect(clampToRange("factor", 100)).toBe(8);
  });

  test("rounds a whole-number setting first and leaves a fractional one alone", () => {
    expect(clampToRange("quality", 20.6)).toBe(21);
    expect(clampToRange("quality", 51.4)).toBe(51);
    expect(clampToRange("factor", 1.375)).toBe(1.375);
  });
});
