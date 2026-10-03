/** The `fg` command: DLSS Frame Generation, interpolating a video to a higher frame rate. */
import { ENCODE_CODECS, FRAME_GEN_ENGINES, SETTING_RANGES } from "../server/api-types.ts";
import { processFrameGen } from "../pipeline/framegen.ts";
import { choiceOption, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec } from "./commands.ts";
import { printHelp } from "./help.ts";

export async function fgCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args, commandSpec("fg"));
  const input = positional[0];
  if (!input) {
    console.error("error: missing <input.mp4>\n");
    printHelp("fg");
    process.exit(1);
  }
  const result = await processFrameGen({
    input,
    output: positional[1],
    targetFps: option(args, "--fps"),
    // 16x is the top of the FPS table's reach from a 30 fps source (480).
    multiplier: numberOption(args, "--multiplier", { min: 1, max: 16, integer: true, fallback: 2 }),
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
