/**
 * The CLI help states the limits the CLI enforces: each numeric row prints its range from the same
 * SETTING_RANGES entry the option is checked against. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { commandSpec, FG_MULTIPLIER_OPTION, optionName, SR_FACTOR_OPTION, VIDEO_STEP_OPTS, WARMUP_OPTION } from "../src/cli/commands.ts";
import { DEFAULT_SR_PRESET, DLSS_RATIO, DlssRenderPreset, PerfQuality, perfQualityName } from "../src/ngx/results.ts";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_WARMUP_FRAMES, DLSS_SR_MAX_OUTPUT_SIDE, SETTING_RANGES } from "../src/server/api-types.ts";

/** The help row of `flag` ("--intensity") in `command`'s table entry. */
function optionRow(command: string, flag: string) {
  const row = commandSpec(command).options.find((option) => optionName(option) === flag);
  if (!row) throw new Error(`${command} has no ${flag} row`);
  return row;
}

describe("numeric option rows print the range that is enforced", () => {
  const rows = [
    ["nr", "--intensity", "intensity"],
    ["nr", "--local-tone", "localTone"],
    ["nr", "--local-structure", "localStructure"],
    ["nr", "--skin-structure", "skinStructure"],
    ["fg", "--quality", "quality"],
    ["video", "--factor", "factor"],
    ["video", "--size", "width"],
    ["video", "--size", "height"],
    ["video", "--quality", "quality"],
    ["video", "--intensity", "intensity"],
  ] as const;

  for (const [command, flag, field] of rows) {
    test(`${command} ${flag}`, () => {
      const { min, max } = SETTING_RANGES[field];
      const { desc } = optionRow(command, flag);
      expect(desc).toContain(`${min}..${max}`);
      // A hard limit is not advice.
      expect(desc).not.toMatch(/typical/i);
    });
  }
});

describe("sr --factor", () => {
  test("the row prints the range, the default, the size rule and its limit", () => {
    const { desc, def } = optionRow("sr", "--factor");
    expect(SR_FACTOR_OPTION.min).toBe(1);
    expect(desc).toContain(`${SR_FACTOR_OPTION.min}..${SR_FACTOR_OPTION.max}`);
    expect(desc).toMatch(/the output is the source size times N, each side rounded to even, as in an image job/);
    expect(desc).toContain(`at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side`);
    expect(desc).toMatch(/1 runs DLAA/);
    expect(def).toBe(String(SR_FACTOR_OPTION.fallback));
  });

  test("sr and nr take an image job's warm-up passes, with its range and default", () => {
    for (const command of ["sr", "nr"]) {
      const { desc, def } = optionRow(command, "--warmup");
      expect(desc).toContain(`${WARMUP_OPTION.min}..${WARMUP_OPTION.max}`);
      expect(def).toBe(String(DEFAULT_WARMUP_FRAMES));
    }
  });

  test("the mode list in the row is the one the runtime accepts", () => {
    const { desc } = optionRow("sr", "--factor");
    for (const quality of Object.keys(DLSS_RATIO)) expect(desc).toContain(perfQualityName(Number(quality)));
    expect(desc).not.toContain(perfQualityName(PerfQuality.UltraQuality));
  });
});

describe("sr --preset", () => {
  test("the row names exactly the presets DlssRenderPreset defines, and the default", () => {
    // The row writes the letters as ranges; spelled out, they must be the enum's keys in order.
    const letters = (first: string, last: string) =>
      Array.from({ length: last.charCodeAt(0) - first.charCodeAt(0) + 1 }, (_, offset) => String.fromCharCode(first.charCodeAt(0) + offset));
    const { desc, def } = optionRow("sr", "--preset");
    expect(desc).toContain("Default, A-F or J-O");
    expect(Object.keys(DlssRenderPreset)).toEqual(["Default", ...letters("A", "F"), ...letters("J", "O")]);
    expect(def).toBe(DEFAULT_SR_PRESET);
  });
});

describe("video", () => {
  test("shares its encode and rate rows with fg and its look rows with nr, so the pages cannot disagree", () => {
    for (const flag of ["--codec", "--quality", "--fps", "--multiplier"]) expect(optionRow("video", flag)).toBe(optionRow("fg", flag));
    for (const flag of ["--intensity", "--style", "--preset", "--local-tone", "--local-structure", "--skin-structure", "--auto-mask", "--ui-correction"]) {
      expect(optionRow("video", flag)).toBe(optionRow("nr", flag));
    }
    expect(optionRow("video", "--fg-path").desc).toBe(optionRow("fg", "--engine").desc);
  });

  test("every step's options are on the page, after the step switches", () => {
    const flags = commandSpec("video").options.map(optionName);
    for (const step of ["sr", "nr", "fg"] as const) {
      expect(flags.indexOf(`--${step}`), step).toBeGreaterThanOrEqual(0);
      for (const row of VIDEO_STEP_OPTS[step]) expect(flags.indexOf(optionName(row)), row.flag).toBeGreaterThan(flags.indexOf("--fg"));
    }
  });

  test("the encode rows print the defaults a job without encode settings gets", () => {
    expect(optionRow("video", "--quality").def).toBe(String(DEFAULT_ENCODE_SETTINGS.quality));
    expect(optionRow("video", "--container").def).toBe(DEFAULT_ENCODE_SETTINGS.container);
    expect(optionRow("video", "--codec").def).toStartWith(DEFAULT_ENCODE_SETTINGS.codec);
  });

  test("--factor states Super Resolution's range and limit, and the resize's range without it", () => {
    const { desc } = optionRow("video", "--factor");
    expect(desc).toContain(`with --sr, Super Resolution upscales to it, N ${SR_FACTOR_OPTION.min}..${SR_FACTOR_OPTION.max}`);
    expect(desc).toContain(`at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side`);
    expect(desc).toContain(`without it, the decode resizes to it with lanczos, N ${SETTING_RANGES.factor.min}..${SETTING_RANGES.factor.max}`);
  });
});

describe("fg --multiplier", () => {
  test("the row prints the whole-number range and the default", () => {
    const { desc, def } = optionRow("fg", "--multiplier");
    expect(desc).toContain(`a whole number from ${FG_MULTIPLIER_OPTION.min} to ${FG_MULTIPLIER_OPTION.max}`);
    expect(def).toBe(String(FG_MULTIPLIER_OPTION.fallback));
  });
});
