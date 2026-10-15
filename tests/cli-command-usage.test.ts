/**
 * Each command ends a command line it cannot use with a UsageError (exit status 2) before it opens a file
 * or the GPU. Only argument checks run here: no call below reads an input or opens the GPU.
 */
import { describe, expect, test } from "bun:test";
import { DlssRenderPreset, DEFAULT_SR_PRESET } from "../src/ngx/results.ts";
import { dlssVersionOption } from "../src/cli/dlss-version-option.ts";
import { fgCommand, targetFpsOption } from "../src/cli/fg-command.ts";
import { nrCommand } from "../src/cli/nr-command.ts";
import { presetKeyOption, srCommand } from "../src/cli/sr-command.ts";
import { UsageError } from "../src/cli/usage-error.ts";
import { videoRequest } from "../src/cli/video-command.ts";
import { DEFAULT_RUNTIME_DIR } from "../src/paths.ts";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS } from "../src/server/api-types.ts";
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
    const error = await usageErrorOf(() => dlssVersionOption(["--dlss-version", "no-such-version"], DEFAULT_RUNTIME_DIR, "sr"));
    expect(error.message).toBe("--dlss-version no-such-version matches no installed DLSS Super Resolution version; list them with 'bun run src/cli.ts versions'");
    expect(dlssVersionOption([], DEFAULT_RUNTIME_DIR, "sr")).toBeUndefined();
  });
});

describe("nr", () => {
  test("a missing input asks for the nr help page", async () => {
    const error = await usageErrorOf(() => nrCommand([]));
    expect(error.message).toBe("missing <input.png>");
    expect(error.command).toBe("nr");
  });
});

describe("video", () => {
  const INPUT = "C:\\in.mp4";
  const request = (...args: string[]) => videoRequest([INPUT, ...args], DEFAULT_RUNTIME_DIR);

  test("a missing input or engine asks for the video help page", async () => {
    const noInput = await usageErrorOf(() => videoRequest([], DEFAULT_RUNTIME_DIR));
    expect(noInput.message).toBe("missing <input>");
    expect(noInput.command).toBe("video");
    const noEngine = await usageErrorOf(() => request());
    expect(noEngine.message).toBe("missing --engine: one of sr, nr, bypass");
    expect(noEngine.command).toBe("video");
  });

  test("with only an engine, the request is the one a job gets by default, and the API accepts it", () => {
    for (const engine of ["sr", "nr", "bypass"] as const) {
      const built = request("--engine", engine);
      expect(built).toEqual({
        kind: "video", input: INPUT, output: undefined, engine, motion: "none",
        settings: DEFAULT_NR_SETTINGS, scale: DEFAULT_SCALE_SETTINGS, encode: DEFAULT_ENCODE_SETTINGS, dllDir: undefined,
      });
      expect(validateJobRequest(built), engine).toBeNull();
    }
  });

  test("every option lands in its request field", () => {
    const built = request(
      "C:\\out.mkv", "--engine", "nr", "--size", "1280X720", "--motion", "flow", "--codec", "hevc", "--quality", "28",
      "--container", "mkv", "--no-audio", "--intensity", "0.5", "--style", "2", "--skin-structure", "-1", "--auto-mask",
    );
    expect(built.output).toBe("C:\\out.mkv");
    expect(built.motion).toBe("flow");
    expect(built.scale).toEqual({ ...DEFAULT_SCALE_SETTINGS, mode: "size", width: 1280, height: 720 });
    expect(built.encode).toEqual({ codec: "hevc", quality: 28, container: "mkv", copyAudio: false });
    expect(built.settings).toEqual({ ...DEFAULT_NR_SETTINGS, intensity: 0.5, style: 2, autoMask: true });
    expect(request("--engine", "sr", "--factor", "1.5").scale).toEqual({ ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 1.5 });
  });

  test("an output size is given once, as a factor or as WxH", async () => {
    const both = await usageErrorOf(() => request("--engine", "nr", "--factor", "2", "--size", "1280x720"));
    expect(both.message).toBe("--factor and --size both set the output size; give one of them");
    const unreadable = await usageErrorOf(() => request("--engine", "nr", "--size", "1280*720"));
    expect(unreadable.message).toBe('--size expects WIDTHxHEIGHT in whole pixels, e.g. 3840x2160, got "1280*720"');
  });

  // These rules belong to validateJobRequest: the command passes its message on rather than keeping a copy.
  test("a request the API refuses is a usage error with the API's message", async () => {
    const cases = [
      { args: ["--engine", "sr", "--factor", "0.5"], fields: { engine: "sr", scale: { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 0.5 } } },
      { args: ["--engine", "nr", "--size", "8x720"], fields: { engine: "nr", scale: { ...DEFAULT_SCALE_SETTINGS, mode: "size", width: 8, height: 720 } } },
    ];
    for (const { args, fields } of cases) {
      const apiMessage = validateJobRequest({ kind: "video", input: INPUT, motion: "none", settings: DEFAULT_NR_SETTINGS, encode: DEFAULT_ENCODE_SETTINGS, ...fields });
      expect(apiMessage, args.join(" ")).not.toBeNull();
      const error = await usageErrorOf(() => request(...args));
      expect(error.message, args.join(" ")).toBe(apiMessage!);
      expect(error.command, args.join(" ")).toBe("video");
    }
  });

  test("a look option on an engine that has no look settings is refused, not dropped", async () => {
    const one = await usageErrorOf(() => request("--engine", "sr", "--intensity", "1.5"));
    expect(one.message).toBe("--intensity only applies to --engine nr; the sr engine has no Neural Rendering look settings");
    const two = await usageErrorOf(() => request("--engine", "bypass", "--style", "1", "--ui-correction"));
    expect(two.message).toBe("--style, --ui-correction only apply to --engine nr; the bypass engine has no Neural Rendering look settings");
  });

  test("--dlss-version looks among the engine's own feature, and bypass refuses it", async () => {
    const unknown = await usageErrorOf(() => request("--engine", "nr", "--dlss-version", "no-such-version"));
    expect(unknown.message).toBe("--dlss-version no-such-version matches no installed DLSS Neural Rendering version; list them with 'bun run src/cli.ts versions'");
    const bypass = await usageErrorOf(() => request("--engine", "bypass", "--dlss-version", "310"));
    expect(bypass.message).toBe("--dlss-version does not apply to --engine bypass, which loads no DLSS DLL; omit it");
  });

  test("an output path has to end in the container's extension", async () => {
    const named = await usageErrorOf(() => request("C:\\out.mkv", "--engine", "nr"));
    expect(named.message).toBe("output C:\\out.mkv must end in .mp4, the container this job writes (--container, default mp4); rename it or add --container mkv");
    const unnamed = await usageErrorOf(() => request("C:\\out.avi", "--engine", "nr", "--container", "mov"));
    expect(unnamed.message).toBe("output C:\\out.avi must end in .mov, the container this job writes (--container, default mp4); rename it");
    expect(request("C:\\OUT.MKV", "--engine", "nr", "--container", "mkv").output).toBe("C:\\OUT.MKV");
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
