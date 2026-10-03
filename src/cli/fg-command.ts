/** The `fg` command: DLSS Frame Generation, interpolating a video to a higher frame rate. */
import { ENCODE_CODECS, FRAME_GEN_ENGINES, SETTING_RANGES } from "../server/api-types.ts";
import { processFrameGen } from "../pipeline/framegen.ts";
import { resolveTargetRate } from "../pipeline/framegen-plan.ts";
import { choiceOption, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, FG_MULTIPLIER_OPTION } from "./commands.ts";
import { usageError } from "./usage-error.ts";

/**
 * `--fps` as typed, or undefined when absent. A rate the planner cannot resolve is a usage error here, the
 * check validateJobRequest makes for the API, instead of a failure after the source has been probed and the
 * DLSS Frame Generation host has started.
 */
export function targetFpsOption(args: string[]): string | undefined {
  const rate = option(args, "--fps");
  if (rate === undefined) return undefined;
  try {
    resolveTargetRate(rate);
  } catch (error) {
    usageError(`--fps is not a rate this build can produce: ${(error as Error).message}`);
  }
  return rate;
}

export async function fgCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args, commandSpec("fg"));
  const input = positional[0];
  if (!input) usageError("missing <input.mp4>", "fg");
  const result = await processFrameGen({
    input,
    output: positional[1],
    targetFps: targetFpsOption(args),
    multiplier: numberOption(args, "--multiplier", FG_MULTIPLIER_OPTION),
    engine: choiceOption(args, "--engine", FRAME_GEN_ENGINES),
    // The same range the API validates against and the UI clamps to.
    quality: numberOption(args, "--quality", { ...SETTING_RANGES.quality, fallback: 20 }),
    codec: choiceOption(args, "--codec", ENCODE_CODECS),
    runtimeDir: runtimeDirOption(args),
    onProgress: (f, m, frames) => {
      if (frames === undefined) console.log(`  ${(f * 100).toFixed(0)}%  ${m}`);
    },
  });
  const how = result.path === "Cascade" ? `${result.cascadeStages} cascade stage(s)` : result.path === "Native DLSSG" ? `native ${result.nativeMultiplier}x` : "resample";
  console.log(
    `DLSS Frame Generation (${how}): ${result.inputFrames} -> ${result.outputFrames} frames, ${result.sourceFps.toFixed(2)} -> ${result.targetFps} fps; ` +
      `${result.generatedFrames} generated, ${result.copiedFrames} copied, ${result.sceneCuts} scene cut(s), max timing error ${result.maximumTemporalErrorSeconds.toFixed(4)} s, in ${result.ms} ms`,
  );
  console.log(`wrote ${result.output}`);
  process.exit(0);
}
