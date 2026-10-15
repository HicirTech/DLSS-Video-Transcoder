/**
 * The `video` command: builds the video job the web UI would send from the command line, checks it with the
 * server's validateJobRequest and runs it in this process.
 */
import { extname } from "node:path";
import { loadEngine } from "../pipeline/engine-loader.ts";
import { processVideo, videoJobOptions } from "../pipeline/video.ts";
import {
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  ENGINE_KINDS,
  type EncodeSettings,
  type EngineKind,
  type JobRequest,
  MOTION_KINDS,
  type ScaleSettings,
  SETTING_RANGES,
} from "../server/api-types.ts";
import { validateJobRequest } from "../server/validate.ts";
import { adapterOption, choiceOption, flag, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, NR_SETTING_OPTS, QUALITY_OPTION, VIDEO_MOTION_DEFAULT } from "./commands.ts";
import { dlssVersionOption } from "./dlss-version-option.ts";
import { nrSettingsOption } from "./nr-settings-option.ts";
import { usageError } from "./usage-error.ts";

export async function videoCommand(args: string[]): Promise<void> {
  const runtimeDir = runtimeDirOption(args);
  const request = videoRequest(args, runtimeDir);
  const adapterIndex = adapterOption(args);
  await loadEngine(request.engine);
  const result = await processVideo({
    ...videoJobOptions(request, {
      runtimeDir,
      onProgress: (fraction, message, frames) => {
        if (frames === undefined) console.log(`  ${(fraction * 100).toFixed(0)}%  ${message}`);
      },
    }),
    // --adapter picks a GPU by DXGI index; a request names one by CUDA UUID instead, and this one names none.
    adapterIndex,
  });
  console.log(`video (${result.engine}): ${result.frames} frames at ${result.width}x${result.height}, ${result.fps.toFixed(2)} fps, ${result.sceneCuts} scene cut(s), in ${result.ms} ms`);
  console.log(`wrote ${result.output}`);
  // The driver core's Shutdown1 is skipped; exit the process to reclaim NGX.
  process.exit(0);
}

/**
 * The video JobRequest this command line describes. A request the API would refuse is a usage error here,
 * with validateJobRequest's own message, so the command never runs a job POST /api/jobs would turn away.
 */
export function videoRequest(args: string[], runtimeDir: string): JobRequest {
  const positional = positionalArgs(args, commandSpec("video"));
  const input = positional[0];
  if (!input) usageError("missing <input>", "video");
  const engine = choiceOption(args, "--engine", ENGINE_KINDS);
  if (!engine) usageError(`missing --engine: one of ${ENGINE_KINDS.join(", ")}`, "video");
  refuseLookOptions(args, engine);
  const encode = encodeOption(args);
  const request: JobRequest = {
    kind: "video",
    input,
    output: outputArgument(positional[1], encode.container),
    engine,
    motion: choiceOption(args, "--motion", MOTION_KINDS) ?? VIDEO_MOTION_DEFAULT,
    settings: nrSettingsOption(args),
    scale: scaleOption(args),
    encode,
    dllDir: engineDllDir(args, runtimeDir, engine),
  };
  const problem = validateJobRequest(request);
  if (problem) usageError(problem, "video");
  return request;
}

/** Only nr reads the Neural Rendering look settings: on another engine a look option would be dropped without a word. */
function refuseLookOptions(args: string[], engine: EngineKind): void {
  if (engine === "nr") return;
  const given = NR_SETTING_OPTS.map((row) => row.flag.split(/\s+/)[0]!).filter((name) => flag(args, name));
  if (given.length) usageError(`${given.join(", ")} only ${given.length === 1 ? "applies" : "apply"} to --engine nr; the ${engine} engine has no Neural Rendering look settings`, "video");
}

/** The encode settings, each flag defaulting to DEFAULT_ENCODE_SETTINGS: what a job that sends none gets. */
function encodeOption(args: string[]): EncodeSettings {
  return {
    codec: choiceOption(args, "--codec", ENCODE_CODECS) ?? DEFAULT_ENCODE_SETTINGS.codec,
    quality: numberOption(args, "--quality", QUALITY_OPTION),
    container: choiceOption(args, "--container", ENCODE_CONTAINERS) ?? DEFAULT_ENCODE_SETTINGS.container,
    copyAudio: !flag(args, "--no-audio"),
  };
}

/**
 * The output path, when one is given, must end in the container's extension: ffmpeg picks the muxer from the
 * name, while the audio codec and the mux flags follow --container, so a mismatch writes neither as asked.
 */
function outputArgument(output: string | undefined, container: EncodeSettings["container"]): string | undefined {
  if (output === undefined) return undefined;
  const extension = extname(output).slice(1).toLowerCase();
  if (extension === container) return output;
  const named = (ENCODE_CONTAINERS as readonly string[]).includes(extension) ? ` or add --container ${extension}` : "";
  usageError(`output ${output} must end in .${container}, the container this job writes (--container, default ${DEFAULT_ENCODE_SETTINGS.container}); rename it${named}`, "video");
}

/**
 * `--factor` or `--size` as the job's scale; neither keeps the source size, the scale a job gets by default.
 * Super Resolution's floor of 1 for the factor, and the range of each --size side, are validateJobRequest's to check.
 */
function scaleOption(args: string[]): ScaleSettings {
  const size = sizeOption(args);
  const factorGiven = option(args, "--factor") !== undefined;
  if (size && factorGiven) usageError("--factor and --size both set the output size; give one of them", "video");
  if (size) return { ...DEFAULT_SCALE_SETTINGS, mode: "size", ...size };
  if (!factorGiven) return DEFAULT_SCALE_SETTINGS;
  return { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: numberOption(args, "--factor", { ...SETTING_RANGES.factor, fallback: DEFAULT_SCALE_SETTINGS.factor }) };
}

/** `--size WxH` in whole pixels, or undefined when absent. */
function sizeOption(args: string[]): { width: number; height: number } | undefined {
  const raw = option(args, "--size");
  if (raw === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(raw);
  if (!match) usageError(`--size expects WIDTHxHEIGHT in whole pixels, e.g. 3840x2160, got "${raw}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** `--dlss-version` among the versions of the --engine's own feature; bypass loads no DLSS DLL to pick one of. */
function engineDllDir(args: string[], runtimeDir: string, engine: EngineKind): string | undefined {
  if (engine !== "bypass") return dlssVersionOption(args, runtimeDir, engine);
  if (option(args, "--dlss-version") !== undefined) usageError("--dlss-version does not apply to --engine bypass, which loads no DLSS DLL; omit it", "video");
  return undefined;
}
