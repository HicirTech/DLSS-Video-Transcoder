/** The `fg` command: DLSS Frame Generation, interpolating a video to a higher frame rate. */
import { ENCODE_CODECS, FRAME_GEN_ENGINES, SETTING_RANGES } from "../server/api-types.ts";
import { processFrameGen } from "../pipeline/framegen.ts";
import { choiceOption, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, FG_MULTIPLIER_OPTION } from "./commands.ts";
import { usageError } from "./usage-error.ts";

export async function fgCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args, commandSpec("fg"));
  const input = positional[0];
  if (!input) usageError("missing <input.mp4>", "fg");
  const result = await processFrameGen({
    input,
    output: positional[1],
    targetFps: option(args, "--fps"),
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
