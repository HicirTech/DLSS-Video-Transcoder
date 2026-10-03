/** The `sr` command: DLSS Super Resolution on a single PNG, the only true upscaler. */
import { isPng } from "../codec/png/chunks.ts";
import { decodePng } from "../codec/png/decode.ts";
import { encodePng } from "../codec/png/encode.ts";
import { buildRuntimeCatalog } from "../ngx/runtime-catalog.ts";
import { DlssSrSession } from "../ngx/sr.ts";
import { DEFAULT_SR_PRESET, DlssRenderPreset, DLSS_RATIO, perfQualityName, qualityForFactor } from "../ngx/results.ts";
import { describeGpu, openGpu } from "../pipeline/gpu.ts";
import { enhanceStill } from "../pipeline/image.ts";
import { defaultOutputPath } from "../pipeline/output-path.ts";
import { evenSize } from "../pipeline/resize.ts";
import { adapterOption, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, SR_FACTOR_OPTION } from "./commands.ts";
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
  const quality = qualityForFactor(factor);
  const presetKey = presetKeyOption(args);
  const preset = DlssRenderPreset[presetKey];
  // The output size must follow the chosen PerfQuality mode's fixed ratio rather than
  // the raw --factor: a render/output ratio that disagrees with the mode risks
  // CreateFeature failure or artifacts.
  const snappedRatio = DLSS_RATIO[quality];
  const outputWidth = evenSize(image.width * snappedRatio);
  const outputHeight = evenSize(image.height * snappedRatio);
  const output = positional[1] ?? defaultOutputPath(input, "dlss", ".png");

  const runtimeDir = runtimeDirOption(args);
  const dllDir = dllDirOption(args, runtimeDir);

  const session = openGpu({ adapterIndex: adapterOption(args) });
  console.log(describeGpu(session));
  const started = performance.now();
  const sr = DlssSrSession.open(session, {
    renderWidth: image.width,
    renderHeight: image.height,
    outputWidth,
    outputHeight,
    quality,
    preset,
    runtimeDir,
    dllDir,
  });
  const enhanced = await enhanceStill(image, (colour) => ({ rgba: sr.evaluate(colour, true), width: outputWidth, height: outputHeight }));
  await Bun.write(output, encodePng(enhanced, { level: 6 }));
  sr.close();
  // The mode name and the ratio it snapped to, not the PerfQuality index: the
  // index is meaningless to a user and its order is counter-intuitive (0 is the
  // fastest mode, not the best), while the ratio is what --factor became.
  console.log(`DLSS SR: ${image.width}x${image.height} -> ${outputWidth}x${outputHeight} (${perfQualityName(quality)} ${snappedRatio.toFixed(2)}x, preset ${presetKey}) in ${(performance.now() - started).toFixed(1)} ms`);
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
