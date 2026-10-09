/**
 * The CLI help states the limits the CLI enforces: each numeric row prints its range from the same
 * SETTING_RANGES entry the option is checked against. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { commandSpec, FG_MULTIPLIER_OPTION, SR_FACTOR_OPTION, WARMUP_OPTION } from "../src/cli/commands.ts";
import { DLSS_RATIO, DLSS_SR_MAX_OUTPUT_SIDE, PerfQuality, perfQualityName } from "../src/ngx/results.ts";
import { DEFAULT_NR_SETTINGS, SETTING_RANGES } from "../src/server/api-types.ts";

/** The help row of `flag` ("--intensity") in `command`'s table entry. */
function optionRow(command: string, flag: string) {
  const row = commandSpec(command).options.find((option) => option.flag.split(/\s+/)[0] === flag);
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
      expect(def).toBe(String(DEFAULT_NR_SETTINGS.warmupFrames));
    }
  });

  test("the mode list in the row is the one the runtime accepts", () => {
    const { desc } = optionRow("sr", "--factor");
    for (const quality of Object.keys(DLSS_RATIO)) expect(desc).toContain(perfQualityName(Number(quality)));
    expect(desc).not.toContain(perfQualityName(PerfQuality.UltraQuality));
  });
});

describe("fg --multiplier", () => {
  test("the row prints the whole-number range and the default", () => {
    const { desc, def } = optionRow("fg", "--multiplier");
    expect(desc).toContain(`a whole number from ${FG_MULTIPLIER_OPTION.min} to ${FG_MULTIPLIER_OPTION.max}`);
    expect(def).toBe(String(FG_MULTIPLIER_OPTION.fallback));
  });
});
