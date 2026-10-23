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
import { FG_MULTIPLIER_OPTION } from "../src/cli/commands.ts";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS, DEFAULT_SR_STEP, jobSteps } from "../src/server/api-types.ts";
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

  test("a missing input asks for the video help page", async () => {
    const noInput = await usageErrorOf(() => videoRequest([], DEFAULT_RUNTIME_DIR));
    expect(noInput.message).toBe("missing <input>");
    expect(noInput.command).toBe("video");
  });

  test("each step switch alone gives the request a job of that step gets by default, and the API accepts every combination", () => {
    expect(request()).toEqual({ kind: "video", input: INPUT, output: undefined, encode: DEFAULT_ENCODE_SETTINGS });
    expect(request("--sr").superResolution).toEqual({ scale: DEFAULT_SR_STEP.scale, motion: DEFAULT_SR_STEP.motion });
    expect(request("--nr").neuralRendering).toEqual({ settings: DEFAULT_NR_SETTINGS });
    expect(request("--fg").frameGen).toEqual({ multiplier: FG_MULTIPLIER_OPTION.fallback });
    for (const switches of [[], ["--sr"], ["--nr"], ["--fg"], ["--sr", "--nr"], ["--sr", "--fg"], ["--nr", "--fg"], ["--fg", "--nr", "--sr"]]) {
      const built = request(...switches);
      expect(validateJobRequest(built), switches.join(" ")).toBeNull();
      expect(jobSteps(built), switches.join(" ")).toEqual((["sr", "nr", "fg"] as const).filter((step) => switches.includes(`--${step}`)));
    }
  });

  test("every option lands in its request field", () => {
    const built = request(
      "C:\\out.mkv", "--sr", "--nr", "--size", "1280X720", "--motion", "flow", "--codec", "hevc", "--quality", "28",
      "--container", "mkv", "--no-audio", "--intensity", "0.5", "--style", "2", "--skin-structure", "-1", "--auto-mask",
    );
    expect(built.output).toBe("C:\\out.mkv");
    expect(built.superResolution).toEqual({ scale: { ...DEFAULT_SCALE_SETTINGS, mode: "size", width: 1280, height: 720 }, motion: "flow" });
    expect(built.resize).toBeUndefined();
    expect(built.encode).toEqual({ codec: "hevc", quality: 28, container: "mkv", copyAudio: false });
    expect(built.neuralRendering).toEqual({ settings: { ...DEFAULT_NR_SETTINGS, intensity: 0.5, style: 2, autoMask: true } });
    expect(request("--fg", "--fps", "120", "--fg-path", "cascade").frameGen).toEqual({ targetFps: "120", multiplier: FG_MULTIPLIER_OPTION.fallback, engine: "cascade" });
    expect(request("--fg", "--multiplier", "3").frameGen).toEqual({ multiplier: 3 });
  });

  test("without --sr, --factor and --size are a resize", () => {
    expect(request("--nr", "--factor", "0.5")).toMatchObject({ resize: { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 0.5 } });
    expect(request("--sr", "--factor", "2")).toMatchObject({ superResolution: { scale: { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 2 } }, resize: undefined });
  });

  test("an output size is given once, as a factor or as WxH", async () => {
    const both = await usageErrorOf(() => request("--nr", "--factor", "2", "--size", "1280x720"));
    expect(both.message).toBe("--factor and --size both set the output size; give one of them");
    const unreadable = await usageErrorOf(() => request("--nr", "--size", "1280*720"));
    expect(unreadable.message).toBe('--size expects WIDTHxHEIGHT in whole pixels, e.g. 3840x2160, got "1280*720"');
  });

  // These rules belong to validateJobRequest: the command passes its message on rather than keeping a copy.
  test("a request the API refuses is a usage error with the API's message", async () => {
    const cases = [
      { args: ["--sr", "--factor", "0.5"], fields: { superResolution: { scale: { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 0.5 }, motion: "none" } } },
      { args: ["--nr", "--size", "8x720"], fields: { neuralRendering: { settings: DEFAULT_NR_SETTINGS }, resize: { ...DEFAULT_SCALE_SETTINGS, mode: "size", width: 8, height: 720 } } },
    ];
    for (const { args, fields } of cases) {
      const apiMessage = validateJobRequest({ kind: "video", input: INPUT, encode: DEFAULT_ENCODE_SETTINGS, ...fields });
      expect(apiMessage, args.join(" ")).not.toBeNull();
      const error = await usageErrorOf(() => request(...args));
      expect(error.message, args.join(" ")).toBe(apiMessage!);
      expect(error.command, args.join(" ")).toBe("video");
    }
  });

  test("a step's option without the step's switch is refused, not dropped", async () => {
    const one = await usageErrorOf(() => request("--sr", "--intensity", "1.5"));
    expect(one.message).toBe("--intensity applies only with --nr; add --nr or leave it out");
    const two = await usageErrorOf(() => request("--style", "1", "--ui-correction"));
    expect(two.message).toBe("--style, --ui-correction apply only with --nr; add --nr or leave them out");
    const motion = await usageErrorOf(() => request("--nr", "--motion", "flow"));
    expect(motion.message).toBe("--motion applies only with --sr; add --sr or leave it out");
    const rate = await usageErrorOf(() => request("--fps", "60"));
    expect(rate.message).toBe("--fps applies only with --fg; add --fg or leave it out");
  });

  test("the options a step switch replaced name their replacements", async () => {
    const engine = await usageErrorOf(() => request("--engine", "nr"));
    expect(engine.message).toBe("--engine was replaced by a switch per step: --sr, --nr and --fg (--engine bypass is none of them)");
    const version = await usageErrorOf(() => request("--nr", "--dlss-version", "310"));
    expect(version.message).toBe("--dlss-version was replaced by a version option per step: --sr-version, --nr-version and --fg-version");
  });

  test("each step's version option looks among its own feature's versions", async () => {
    const unknown = await usageErrorOf(() => request("--nr", "--nr-version", "no-such-version"));
    expect(unknown.message).toBe("--nr-version no-such-version matches no installed DLSS Neural Rendering version; list them with 'bun run src/cli.ts versions'");
    const frameGen = await usageErrorOf(() => request("--fg", "--fg-version", "no-such-version"));
    expect(frameGen.message).toBe("--fg-version no-such-version matches no installed DLSS Frame Generation version; list them with 'bun run src/cli.ts versions'");
  });

  test("frame generation writes MP4 only", async () => {
    const error = await usageErrorOf(() => request("--fg", "--container", "mkv"));
    expect(error.message).toBe("--fg writes mp4 only; leave --container out or give --container mp4");
  });

  test("an output path has to end in the container's extension", async () => {
    const named = await usageErrorOf(() => request("C:\\out.mkv", "--nr"));
    expect(named.message).toBe("output C:\\out.mkv must end in .mp4, the container this job writes (--container, default mp4); rename it or add --container mkv");
    const unnamed = await usageErrorOf(() => request("C:\\out.avi", "--nr", "--container", "mov"));
    expect(unnamed.message).toBe("output C:\\out.avi must end in .mov, the container this job writes (--container, default mp4); rename it");
    expect(request("C:\\OUT.MKV", "--nr", "--container", "mkv").output).toBe("C:\\OUT.MKV");
    // With --fg, --container takes mp4 only, so the refusal does not send the user to --container mkv.
    const frameGen = await usageErrorOf(() => request("C:\\out.mkv", "--fg"));
    expect(frameGen.message).toBe("output C:\\out.mkv must end in .mp4, the container this job writes (--container, default mp4); rename it");
  });
});

describe("fg", () => {
  test("a missing input asks for the fg help page", async () => {
    const error = await usageErrorOf(() => fgCommand([]));
    expect(error.message).toBe("missing <input.mp4>");
    expect(error.command).toBe("fg");
  });

  test("an output path has to end in .mp4, the container frame generation writes", async () => {
    for (const output of ["C:\\out.mkv", "C:\\out"]) {
      const error = await usageErrorOf(() => fgCommand(["C:\\in.mp4", output]));
      expect(error.message, output).toBe(`output ${output} must end in .mp4, the container frame generation writes; rename it`);
      expect(error.command, output).toBe("fg");
    }
    // --fps is read after the output, so its refusal shows the output was accepted.
    const accepted = await usageErrorOf(() => fgCommand(["C:\\in.mp4", "C:\\OUT.MP4", "--fps", "x"]));
    expect(accepted.message).toStartWith("--fps is not a rate this build can produce: ");
  });

  test("a --dlss-version that matches no installed Frame Generation version is a usage error that says how to list them", async () => {
    const error = await usageErrorOf(() => dlssVersionOption(["--dlss-version", "no-such-version"], DEFAULT_RUNTIME_DIR, "fg"));
    expect(error.message).toBe("--dlss-version no-such-version matches no installed DLSS Frame Generation version; list them with 'bun run src/cli.ts versions'");
  });

  // The API's check on frameGen.targetFps (validateJobRequest) and this one both ask resolveTargetRate.
  test("--fps accepts exactly the rates the API accepts, and a refusal names the rates that work", async () => {
    const apiAccepts = (targetFps: string): boolean => validateJobRequest({ kind: "video", input: "C:\\in.mp4", frameGen: { targetFps } }) === null;
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
