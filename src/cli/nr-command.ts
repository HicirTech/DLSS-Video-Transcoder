/** The `nr` command: DLSS Neural Rendering on a single PNG, at the same size. */
import { decodePng } from "../codec/png/decode.ts";
import { encodePng } from "../codec/png/encode.ts";
import type { RgbaImage } from "../codec/png/types.ts";
import { DlssNrSession } from "../ngx/nr-render.ts";
import { describeGpu, openGpu } from "../pipeline/gpu.ts";
import { enhanceStill, requirePng, runStillPasses } from "../pipeline/image.ts";
import { defaultOutputPath } from "../pipeline/output-path.ts";
import { stepsSuffix } from "../server/api-types.ts";
import { adapterOption, numberOption, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, NR_STACK_OPTION, WARMUP_OPTION } from "./commands.ts";
import { nrSettingsOption } from "./nr-settings-option.ts";
import { usageError } from "./usage-error.ts";

export async function nrCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args, commandSpec("nr"));
  const input = positional[0];
  if (!input) usageError("missing <input.png>", "nr");
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  requirePng(input, bytes, "the nr command");
  const image = decodePng(bytes);
  const stack = numberOption(args, "--stack", NR_STACK_OPTION);
  const output = positional[1] ?? defaultOutputPath(input, stepsSuffix(["nr"], false, stack), ".png");
  const settings = nrSettingsOption(args);
  const warmupFrames = numberOption(args, "--warmup", WARMUP_OPTION);
  const session = openGpu({ adapterIndex: adapterOption(args) });
  console.log(describeGpu(session));
  const started = performance.now();
  let enhanced: RgbaImage;
  try {
    const nr = DlssNrSession.open(session, {
      width: image.width,
      height: image.height,
      settings,
      runtimeDir: runtimeDirOption(args),
    });
    try {
      enhanced = await enhanceStill(image, async (colour) => ({
        rgba: await stackedPasses(nr, colour, { stack, warmupFrames }),
        width: image.width,
        height: image.height,
      }));
    } finally {
      nr.close();
    }
  } finally {
    session.close();
  }
  await Bun.write(output, encodePng(enhanced));
  // Only settings the runtime acts on are worth reporting; the preset is not one of them.
  console.log(`DLSS NR: ${image.width}x${image.height} enhanced (style ${settings.style}, intensity ${settings.intensity}, ${warmupFrames + 1} passes${stack > 1 ? `, stacked ${stack} times` : ""}) in ${(performance.now() - started).toFixed(1)} ms`);
  console.log(`wrote ${output}`);
  process.exit(0);
}

/** `colour` through `stack` Neural Rendering passes on one session, each pass's warm-up run on the output of the pass before. */
async function stackedPasses(nr: DlssNrSession, colour: Uint8Array, { stack, warmupFrames }: { stack: number; warmupFrames: number }): Promise<Uint8Array> {
  let output = colour;
  for (let pass = 0; pass < stack; pass++) {
    const input = output;
    // Each pass starts with a reset, which clears the history of the pass before: measured 2026-10-23, a pass on a
    // reset instance gives the same bytes as on a fresh one, so the image job's one instance per pass agrees with this.
    output = await runStillPasses(true, warmupFrames, (reset) => nr.evaluate(input, reset));
  }
  return output;
}
