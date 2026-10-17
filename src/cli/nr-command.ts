/** The `nr` command: DLSS Neural Rendering on a single PNG, at the same size. */
import { isPng } from "../codec/png/chunks.ts";
import { decodePng } from "../codec/png/decode.ts";
import { encodePng } from "../codec/png/encode.ts";
import { DlssNrSession } from "../ngx/nr-render.ts";
import { describeGpu, openGpu } from "../pipeline/gpu.ts";
import { enhanceStill, runStillPasses } from "../pipeline/image.ts";
import { defaultOutputPath } from "../pipeline/output-path.ts";
import { adapterOption, numberOption, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, WARMUP_OPTION } from "./commands.ts";
import { nrSettingsOption } from "./nr-settings-option.ts";
import { usageError } from "./usage-error.ts";

export async function nrCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args, commandSpec("nr"));
  const input = positional[0];
  if (!input) usageError("missing <input.png>", "nr");
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  if (!isPng(bytes)) {
    console.error(`${input}: only PNG input is supported by the nr command`);
    process.exit(1);
  }
  const image = decodePng(bytes);
  const output = positional[1] ?? defaultOutputPath(input, "nr", ".png");
  const settings = nrSettingsOption(args);
  const warmupFrames = numberOption(args, "--warmup", WARMUP_OPTION);
  const session = openGpu({ adapterIndex: adapterOption(args) });
  console.log(describeGpu(session));
  const started = performance.now();
  const nr = DlssNrSession.open(session, {
    width: image.width,
    height: image.height,
    settings,
    runtimeDir: runtimeDirOption(args),
  });
  const enhanced = await enhanceStill(image, async (colour) => ({
    rgba: await runStillPasses(true, warmupFrames, (reset) => nr.evaluate(colour, reset)),
    width: image.width,
    height: image.height,
  }));
  await Bun.write(output, encodePng(enhanced, { level: 6 }));
  nr.close();
  // Only settings the runtime acts on are worth reporting; the preset is not one of them.
  console.log(`DLSS NR: ${image.width}x${image.height} enhanced (style ${settings.style}, intensity ${settings.intensity}, ${warmupFrames + 1} passes) in ${(performance.now() - started).toFixed(1)} ms`);
  console.log(`wrote ${output}`);
  process.exit(0);
}
