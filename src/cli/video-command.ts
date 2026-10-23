/**
 * The `video` command: builds the video job the web UI would send from the command line, checks it with the
 * server's validateJobRequest and runs it in this process.
 */
import { extname } from "node:path";
import { loadEngines } from "../pipeline/engine-loader.ts";
import type { ProgressReporter } from "../pipeline/frame-progress.ts";
import { frameGenJobOptions, processFrameGen } from "../pipeline/framegen.ts";
import { processVideo, videoJobOptions } from "../pipeline/video.ts";
import {
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
  DEFAULT_SR_STEP,
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  type EncodeSettings,
  FRAME_GEN_CONTAINER,
  FRAME_GEN_ENGINES,
  FRAME_GEN_GPU_CHOICE,
  type FrameGenStep,
  type JobRequest,
  MOTION_KINDS,
  type ScaleSettings,
  SETTING_RANGES,
  STEP_KINDS,
  stepsPresent,
  type StepKind,
} from "../server/api-types.ts";
import { takesGpuChoice } from "../server/settings-in-use.ts";
import { validateJobRequest } from "../server/validate.ts";
import { adapterOption, choiceOption, flag, numberOption, option, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec, FG_MULTIPLIER_OPTION, QUALITY_OPTION, VIDEO_STEP_OPTS } from "./commands.ts";
import { stepVersionOption } from "./dlss-version-option.ts";
import { frameGenSummary, targetFpsOption } from "./fg-command.ts";
import { nrSettingsOption } from "./nr-settings-option.ts";
import { usageError } from "./usage-error.ts";

export async function videoCommand(args: string[]): Promise<void> {
  const runtimeDir = runtimeDirOption(args);
  const request = videoRequest(args, runtimeDir);
  const adapterIndex = adapterOption(args);
  const shape = stepsPresent(request);
  if (adapterIndex !== undefined && !takesGpuChoice(shape)) {
    usageError(`--adapter picks the GPU for --sr and --nr; frame generation picks its own (${FRAME_GEN_GPU_CHOICE}), so with --fg alone leave it out`, "video");
  }
  await loadEngines(shape);
  const onProgress: ProgressReporter = (fraction, message, frames) => {
    if (frames === undefined) console.log(`  ${(fraction * 100).toFixed(0)}%  ${message}`);
  };
  const run = { runtimeDir, onProgress };
  // --adapter picks a GPU by DXGI index; a request names one by CUDA UUID instead, and this one names none.
  if (request.frameGen) {
    const result = await processFrameGen({ ...frameGenJobOptions(request, request.frameGen, run), adapterIndex });
    console.log(`video (${result.steps.join(", ")}): ${result.width}x${result.height}; ${frameGenSummary(result)}`);
    console.log(`wrote ${result.output}`);
  } else {
    const result = await processVideo({ ...videoJobOptions(request, run), adapterIndex });
    console.log(`video (${result.steps.length ? result.steps.join(", ") : "re-encode"}): ${result.frames} frames at ${result.width}x${result.height}, ${result.fps.toFixed(2)} fps, ${result.sceneCuts} scene cut(s), in ${result.ms} ms`);
    console.log(`wrote ${result.output}`);
  }
  // The driver core's Shutdown1 is skipped; exit the process to reclaim NGX.
  process.exit(0);
}

/** The options `video` had before each step got its own switch, and what replaced them. */
const REPLACED_OPTIONS: Record<string, string> = {
  "--engine": "--engine was replaced by a switch per step: --sr, --nr and --fg (--engine bypass is none of them)",
  "--dlss-version": "--dlss-version was replaced by a version option per step: --sr-version, --nr-version and --fg-version",
};

/**
 * The video JobRequest this command line describes. A request the API would refuse is a usage error here,
 * with validateJobRequest's own message, so the command never runs a job POST /api/jobs would turn away.
 */
export function videoRequest(args: string[], runtimeDir: string): JobRequest {
  for (const [name, replacement] of Object.entries(REPLACED_OPTIONS)) if (flag(args, name)) usageError(replacement, "video");
  const positional = positionalArgs(args, commandSpec("video"));
  const input = positional[0];
  if (!input) usageError("missing <input>", "video");
  const steps: Record<StepKind, boolean> = { sr: flag(args, "--sr"), nr: flag(args, "--nr"), fg: flag(args, "--fg") };
  refuseOptionsWithoutStep(args, steps);
  const encode = encodeOption(args);
  if (steps.fg && encode.container !== FRAME_GEN_CONTAINER) usageError(`--fg writes ${FRAME_GEN_CONTAINER} only; leave --container out or give --container ${FRAME_GEN_CONTAINER}`, "video");
  const size = sizeOption(args);
  const request: JobRequest = {
    kind: "video",
    input,
    output: outputArgument(positional[1], encode.container),
    superResolution: steps.sr
      ? { scale: size ?? DEFAULT_SR_STEP.scale, motion: choiceOption(args, "--motion", MOTION_KINDS) ?? DEFAULT_SR_STEP.motion, dllDir: stepVersionOption(args, runtimeDir, "sr") }
      : undefined,
    neuralRendering: steps.nr ? { settings: nrSettingsOption(args), dllDir: stepVersionOption(args, runtimeDir, "nr") } : undefined,
    frameGen: steps.fg ? frameGenOption(args, runtimeDir) : undefined,
    // Super Resolution sets the output size itself; without it, --factor or --size is a resize.
    resize: steps.sr ? undefined : size,
    encode,
  };
  const problem = validateJobRequest(request);
  if (problem) usageError(problem, "video");
  return request;
}

/** A step's options mean nothing without its switch: taking them anyway would drop them without a word. */
function refuseOptionsWithoutStep(args: string[], steps: Record<StepKind, boolean>): void {
  for (const step of STEP_KINDS) {
    if (steps[step]) continue;
    const given = VIDEO_STEP_OPTS[step].map((row) => row.flag.split(/\s+/)[0]!).filter((name) => flag(args, name));
    if (given.length) usageError(`${given.join(", ")} ${given.length === 1 ? "applies" : "apply"} only with --${step}; add --${step} or leave ${given.length === 1 ? "it" : "them"} out`, "video");
  }
}

/** The frame generation step, read as the fg command reads it: --fps wins over --multiplier, which defaults to FG_MULTIPLIER_OPTION.fallback. */
function frameGenOption(args: string[], runtimeDir: string): FrameGenStep {
  return {
    targetFps: targetFpsOption(args),
    multiplier: numberOption(args, "--multiplier", FG_MULTIPLIER_OPTION),
    engine: choiceOption(args, "--fg-path", FRAME_GEN_ENGINES),
    dllDir: stepVersionOption(args, runtimeDir, "fg"),
  };
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
 * The output size `--factor` or `--size` gives, or undefined for neither. Super Resolution's floor of 1 for the
 * factor, and the range of each --size side, are validateJobRequest's to check.
 */
function sizeOption(args: string[]): ScaleSettings | undefined {
  const size = sizeArgument(args);
  const factorGiven = option(args, "--factor") !== undefined;
  if (size && factorGiven) usageError("--factor and --size both set the output size; give one of them", "video");
  if (size) return { ...DEFAULT_SCALE_SETTINGS, mode: "size", ...size };
  if (!factorGiven) return undefined;
  return { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: numberOption(args, "--factor", { ...SETTING_RANGES.factor, fallback: DEFAULT_SCALE_SETTINGS.factor }) };
}

/** `--size WxH` in whole pixels, or undefined when absent. */
function sizeArgument(args: string[]): { width: number; height: number } | undefined {
  const raw = option(args, "--size");
  if (raw === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(raw);
  if (!match) usageError(`--size expects WIDTHxHEIGHT in whole pixels, e.g. 3840x2160, got "${raw}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
