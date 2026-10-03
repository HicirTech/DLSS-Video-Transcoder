/**
 * The CLI help states the limits the CLI enforces: each numeric row prints its range from the same
 * SETTING_RANGES entry the option is checked against. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { commandSpec } from "../src/cli/commands.ts";
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
