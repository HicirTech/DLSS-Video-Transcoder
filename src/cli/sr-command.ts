/** The `sr` command: DLSS Super Resolution on a single PNG, the only true upscaler. */
import { decodePng } from "../codec/png/decode.ts";
import { encodePng } from "../codec/png/encode.ts";
import type { RgbaImage } from "../codec/png/types.ts";
import { DlssSrSession } from "../ngx/sr.ts";
import { DEFAULT_SR_PRESET, DlssRenderPreset, perfQualityName, qualityForSizes } from "../ngx/results.ts";
import { describeGpu, openGpu } from "../pipeline/gpu.ts";
import { enhanceStill, requirePng, runStillPasses } from "../pipeline/image.ts";
import { defaultOutputPath } from "../pipeline/output-path.ts";
import { DEFAULT_SCALE_SETTINGS } from "../server/api-types.ts";
import { resolveTargetSize, srOutputProblem } from "../server/output-size.ts";
import { adapterOption, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, SR_FACTOR_OPTION, WARMUP_OPTION } from "./commands.ts";
import { dlssVersionOption } from "./dlss-version-option.ts";
import { usageError } from "./usage-error.ts";

export async function srCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args, commandSpec("sr"));
  const input = positional[0];
  if (!input) usageError("missing <input.png>", "sr");
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  requirePng(input, bytes, "the sr command");
  const image = decodePng(bytes);
  const factor = numberOption(args, "--factor", SR_FACTOR_OPTION);
  const warmupFrames = numberOption(args, "--warmup", WARMUP_OPTION);
  const presetKey = presetKeyOption(args);
  const preset = DlssRenderPreset[presetKey];
  // An image job's size rule, so the command and a job write the same size from the same factor.
  const target = resolveTargetSize(image.width, image.height, { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor });
  const sizeProblem = srOutputProblem(image, target);
  if (sizeProblem) usageError(sizeProblem, "sr");
  const quality = qualityForSizes(image.width, target.width);
  const output = positional[1] ?? defaultOutputPath(input, "sr", ".png");

  const runtimeDir = runtimeDirOption(args);
  const dllDir = dlssVersionOption(args, runtimeDir, "sr");

  const session = openGpu({ adapterIndex: adapterOption(args) });
  console.log(describeGpu(session));
  const started = performance.now();
  let enhanced: RgbaImage;
  try {
    const sr = DlssSrSession.open(session, {
      renderWidth: image.width,
      renderHeight: image.height,
      outputWidth: target.width,
      outputHeight: target.height,
      quality,
      preset,
      runtimeDir,
      dllDir,
    });
    try {
      enhanced = await enhanceStill(image, async (colour) => ({
        rgba: await runStillPasses(true, warmupFrames, (reset) => sr.evaluate(colour, reset)),
        width: target.width,
        height: target.height,
      }));
    } finally {
      sr.close();
    }
  } finally {
    session.close();
  }
  await Bun.write(output, encodePng(enhanced));
  // The mode name, not the PerfQuality index: the index is meaningless to a user
  // and does not run in order of quality or speed (0 is MaxPerf, 3 UltraPerformance, 5 DLAA).
  console.log(`DLSS SR: ${image.width}x${image.height} -> ${target.width}x${target.height} (${perfQualityName(quality)} mode, preset ${presetKey}, ${warmupFrames + 1} passes) in ${(performance.now() - started).toFixed(1)} ms`);
  console.log(`wrote ${output}`);
  // The driver core's Shutdown1 is skipped; exit the process to reclaim NGX.
  process.exit(0);
}

/** `--preset` as a DlssRenderPreset key, or the default preset when absent. */
export function presetKeyOption(args: string[]): keyof typeof DlssRenderPreset {
  // DlssRenderPreset keys are mixed case ("Default", not "DEFAULT"), so match
  // case-insensitively; an unknown name is an error, not a silent fallback to DEFAULT_SR_PRESET.
  const presetInput = option(args, "--preset") ?? DEFAULT_SR_PRESET;
  const presetKey = (Object.keys(DlssRenderPreset) as (keyof typeof DlssRenderPreset)[]).find((k) => k.toLowerCase() === presetInput.toLowerCase());
  if (!presetKey) usageError(`unknown --preset '${presetInput}'. Valid: ${Object.keys(DlssRenderPreset).join(", ")}`);
  return presetKey;
}
