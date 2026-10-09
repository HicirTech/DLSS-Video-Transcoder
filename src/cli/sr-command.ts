/** The `sr` command: DLSS Super Resolution on a single PNG, the only true upscaler. */
import { isPng } from "../codec/png/chunks.ts";
import { decodePng } from "../codec/png/decode.ts";
import { encodePng } from "../codec/png/encode.ts";
import { buildRuntimeCatalog } from "../ngx/runtime-catalog.ts";
import { DlssSrSession } from "../ngx/sr.ts";
import { DEFAULT_SR_PRESET, DlssRenderPreset, perfQualityName, qualityForSizes, srOutputProblem } from "../ngx/results.ts";
import { describeGpu, openGpu } from "../pipeline/gpu.ts";
import { enhanceStill, resolveTargetSize, runStillPasses } from "../pipeline/image.ts";
import { defaultOutputPath } from "../pipeline/output-path.ts";
import { DEFAULT_SCALE_SETTINGS } from "../server/api-types.ts";
import { adapterOption, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, SR_FACTOR_OPTION, WARMUP_OPTION } from "./commands.ts";
import { usageError } from "./usage-error.ts";

export async function srCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args, commandSpec("sr"));
  const input = positional[0];
  if (!input) usageError("missing <input.png>", "sr");
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  if (!isPng(bytes)) {
    console.error(`${input}: only PNG input is supported by the sr command`);
    process.exit(1);
  }
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
  const dllDir = dllDirOption(args, runtimeDir);

  const session = openGpu({ adapterIndex: adapterOption(args) });
  console.log(describeGpu(session));
  const started = performance.now();
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
  const enhanced = await enhanceStill(image, async (colour) => ({
    rgba: await runStillPasses("sr", warmupFrames, (reset) => sr.evaluate(colour, reset)),
    width: target.width,
    height: target.height,
  }));
  await Bun.write(output, encodePng(enhanced, { level: 6 }));
  sr.close();
  // The mode name, not the PerfQuality index: the index is meaningless to a user
  // and its order is counter-intuitive (0 is the fastest mode, not the best).
  console.log(`DLSS SR: ${image.width}x${image.height} -> ${target.width}x${target.height} (${perfQualityName(quality)} mode, preset ${presetKey}, ${warmupFrames + 1} passes) in ${(performance.now() - started).toFixed(1)} ms`);
  console.log(`wrote ${output}`);
  // The driver core's Shutdown1 is skipped; exit the process to reclaim NGX.
  process.exit(0);
}

/** `--preset` as a DlssRenderPreset key, or the default preset when absent. */
export function presetKeyOption(args: string[]): keyof typeof DlssRenderPreset {
  // DlssRenderPreset keys are mixed case ("Default", not "DEFAULT"), so match
  // case-insensitively; an unknown name is an error, not a silent fallback to L.
  const presetInput = option(args, "--preset") ?? DEFAULT_SR_PRESET;
  const presetKey = (Object.keys(DlssRenderPreset) as (keyof typeof DlssRenderPreset)[]).find((k) => k.toLowerCase() === presetInput.toLowerCase());
  if (!presetKey) usageError(`unknown --preset '${presetInput}'. Valid: ${Object.keys(DlssRenderPreset).join(", ")}`);
  return presetKey;
}

/** The folder of the installed SR DLL that `--dlss-version` names, or undefined to use the bundled runtime DLL. */
export function dllDirOption(args: string[], runtimeDir: string): string | undefined {
  const wantVersion = option(args, "--dlss-version");
  if (!wantVersion) return undefined;
  const sr = buildRuntimeCatalog(runtimeDir).features.find((f) => f.id === 1);
  const match = sr?.versions.find((v) => v.version === wantVersion || v.version.startsWith(wantVersion));
  if (!match) usageError(`--dlss-version ${wantVersion} matches no installed DLSS SR version; list them with 'bun run src/cli.ts versions'`);
  console.log(`using DLSS SR ${match.version} (${match.source}) from ${match.dir}`);
  return match.dir;
}
