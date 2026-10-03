/**
 * Each command ends a command line it cannot use with a UsageError (exit status 2) before it opens a file
 * or the GPU. Only argument checks run here: every call below fails before any input is read. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { DlssRenderPreset, DEFAULT_SR_PRESET } from "../src/ngx/results.ts";
import { dllDirOption, presetKeyOption, srCommand } from "../src/cli/sr-command.ts";
import { UsageError } from "../src/cli/usage-error.ts";
import { DEFAULT_RUNTIME_DIR } from "../src/paths.ts";

/** The UsageError `run` raises or rejects with; any other outcome fails the test. */
async function usageErrorOf(run: () => unknown): Promise<UsageError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error("expected a UsageError, but nothing was raised");
}

describe("sr", () => {
  test("a missing input asks for the sr help page", async () => {
    const error = await usageErrorOf(() => srCommand([]));
    expect(error.message).toBe("missing <input.png>");
    expect(error.command).toBe("sr");
  });

  test("an unknown --preset is a usage error that lists the presets, and the match ignores case", async () => {
    const error = await usageErrorOf(() => presetKeyOption(["--preset", "zzz"]));
    expect(error.message).toBe(`unknown --preset 'zzz'. Valid: ${Object.keys(DlssRenderPreset).join(", ")}`);
    expect(presetKeyOption(["--preset", "k"])).toBe("K");
    expect(presetKeyOption([])).toBe(DEFAULT_SR_PRESET);
  });

  test("a --dlss-version that matches no installed version is a usage error that says how to list them", async () => {
    const error = await usageErrorOf(() => dllDirOption(["--dlss-version", "no-such-version"], DEFAULT_RUNTIME_DIR));
    expect(error.message).toBe("--dlss-version no-such-version matches no installed DLSS SR version; list them with 'bun run src/cli.ts versions'");
    expect(dllDirOption([], DEFAULT_RUNTIME_DIR)).toBeUndefined();
  });
});
