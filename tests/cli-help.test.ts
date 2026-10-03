/**
 * The CLI help states the limits the CLI enforces: each numeric row prints its range from the same
 * SETTING_RANGES entry the option is checked against. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { commandSpec, FG_MULTIPLIER_OPTION, SR_FACTOR_OPTION } from "../src/cli/commands.ts";
import { DLSS_RATIO, PerfQuality, perfQualityName } from "../src/ngx/results.ts";
import { SETTING_RANGES } from "../src/server/api-types.ts";

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
  test("the row prints the range, the default and what a factor at or below 1 does", () => {
    const { desc, def } = optionRow("sr", "--factor");
    expect(desc).toContain(`${SR_FACTOR_OPTION.min}..${SR_FACTOR_OPTION.max}`);
    expect(desc).toMatch(/1 or less runs DLAA at the source size/);
    expect(desc).toMatch(/above 1 never snaps to DLAA/);
    expect(def).toBe(String(SR_FACTOR_OPTION.fallback));
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
