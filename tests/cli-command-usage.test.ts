/**
 * Each command ends a command line it cannot use with a UsageError (exit status 2) before it opens a file
 * or the GPU. Only argument checks run here: every call below fails before any input is read. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { DlssRenderPreset, DEFAULT_SR_PRESET } from "../src/ngx/results.ts";
import { fgCommand, targetFpsOption } from "../src/cli/fg-command.ts";
import { nrCommand } from "../src/cli/nr-command.ts";
import { dllDirOption, presetKeyOption, srCommand } from "../src/cli/sr-command.ts";
import { UsageError } from "../src/cli/usage-error.ts";
import { DEFAULT_RUNTIME_DIR } from "../src/paths.ts";
import { DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS } from "../src/server/api-types.ts";
import { validateJobRequest } from "../src/server/validate.ts";

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

describe("nr", () => {
  test("a missing input asks for the nr help page", async () => {
    const error = await usageErrorOf(() => nrCommand([]));
    expect(error.message).toBe("missing <input.png>");
    expect(error.command).toBe("nr");
  });
});

describe("fg", () => {
  test("a missing input asks for the fg help page", async () => {
    const error = await usageErrorOf(() => fgCommand([]));
    expect(error.message).toBe("missing <input.mp4>");
    expect(error.command).toBe("fg");
  });

  // The API's check on frameGen.targetFps (validateJobRequest) and this one both ask resolveTargetRate.
  test("--fps accepts exactly the rates the API accepts, and a refusal names the rates that work", async () => {
    const apiAccepts = (targetFps: string): boolean =>
      validateJobRequest({ kind: "video", input: "C:\\in.mp4", engine: "nr", motion: "none", settings: DEFAULT_NR_SETTINGS, scale: DEFAULT_SCALE_SETTINGS, frameGen: { targetFps } }) === null;
    expect(targetFpsOption([])).toBeUndefined();
    for (const rate of ["60", "59.94", "144", "60000/1001", "24.5", " 120 "]) {
      expect(apiAccepts(rate), rate).toBe(true);
      expect(targetFpsOption(["--fps", rate]), rate).toBe(rate);
    }
    for (const rate of ["x", "0", "-5", "1/0", "toString", "60 fps"]) {
      expect(apiAccepts(rate), rate).toBe(false);
      const error = await usageErrorOf(() => targetFpsOption(["--fps", rate]));
      expect(error.message, rate).toStartWith("--fps is not a rate this build can produce: ");
      expect(error.command, rate).toBeUndefined();
    }
    const unreadable = await usageErrorOf(() => targetFpsOption(["--fps", "x"]));
    expect(unreadable.message).toContain("Choose one of: 23.976, 25");
    expect(unreadable.message).toContain("or give an exact rate such as 60000/1001");
  });
});
