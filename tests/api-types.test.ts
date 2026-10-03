/** The settings contract the CLI help, the web editors and the API validation all read from api-types.ts. */
import { describe, expect, test } from "bun:test";
import {
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
