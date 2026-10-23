/**
 * What a form's job will do, worked out in the browser from the source's media info and the settings: the
 * output size and rate, whether Super Resolution can write that size, and the default output name. The rules
 * are the server's own (output-size.ts, stepsSuffix), so the form shows what the job will do.
 */
import { type EncodeSettings, FRAME_GEN_CONTAINER, resizesFrames, type ScaleSettings, STEP_KINDS, type StepKind, stepsSuffix } from "../../src/server/api-types";
import { resolveTargetSize, srOutputProblem, videoTargetSize } from "../../src/server/output-size";
import { rateValue, stemOf } from "./format";
import type { StoredFrameGen } from "./stored-settings";

/** Each step's title on the forms, the job cards and the plan line; a Record, so a step without one is a build error. */
export const STEP_TITLES: Record<StepKind, string> = { sr: "Super Resolution", nr: "Neural Rendering", fg: "Frame generation" };

export interface FrameSize {
  width: number;
  height: number;
}

export interface PlanInput {
  kind: "image" | "video";
  /** The input path as typed; empty while there is none. */
  input: string;
  /** The source's size from GET /api/media, or null while it is unknown. */
  source: FrameSize | null;
  steps: Record<StepKind, boolean>;
  srScale: ScaleSettings;
  resize: ScaleSettings;
  /** The container a video job writes, unless frame generation fixes it; an image job writes PNG. */
  container: EncodeSettings["container"];
}

export interface JobPlan {
  /** The steps that run, in their order. */
  steps: StepKind[];
  /** The size the job writes, or null while the source's size is unknown. */
  outputSize: FrameSize | null;
  /** Why Super Resolution cannot write outputSize, when it runs and cannot: the job would fail on it. */
  srProblem: string | null;
  /** What the job names its output when the form gives none, or null without an input. */
  defaultOutputName: string | null;
}

export function planJob(plan: PlanInput): JobPlan {
  const steps = STEP_KINDS.filter((step) => plan.steps[step]);
  const resized = resizesFrames({ superResolution: plan.steps.sr ? { scale: plan.srScale } : undefined, resize: plan.resize });
  const outputSize = plan.source ? plannedSize(plan, plan.source) : null;
  const srProblem = plan.steps.sr && plan.source && outputSize ? srOutputProblem(plan.source, outputSize) : null;
  const extension = plan.kind === "image" ? "png" : videoContainer(plan.steps, plan.container);
  const input = plan.input.trim();
  const defaultOutputName = input ? `${stemOf(input)}.${stepsSuffix(steps, resized)}.${extension}` : null;
  return { steps, outputSize, srProblem, defaultOutputName };
}

/** The container a video job writes: frame generation fixes it to FRAME_GEN_CONTAINER, otherwise the stored choice. */
export function videoContainer(steps: Record<StepKind, boolean>, stored: EncodeSettings["container"]): EncodeSettings["container"] {
  return steps.fg ? FRAME_GEN_CONTAINER : stored;
}

/** The size the job gives `source`, as the jobs work it out: a video's sides rounded to even for 4:2:0, a still's as they are. */
function plannedSize(plan: PlanInput, source: FrameSize): FrameSize {
  const scale = plan.steps.sr ? plan.srScale : plan.resize;
  return plan.kind === "video" ? videoTargetSize(source, scale) : resolveTargetSize(source.width, source.height, scale);
}

/**
 * Frame generation's output rate in frames per second: the chosen rate, or the source's nominal rate (the clock
 * frame generation plans on) times the multiplier; null when the source's rate is not known yet.
 */
export function frameGenOutputFps(frameGen: StoredFrameGen, nominalFps: string | null): number | null {
  if (frameGen.rateBy === "fps") return rateValue(frameGen.targetFps);
  const source = nominalFps === null ? null : rateValue(nominalFps);
  return source === null ? null : source * frameGen.multiplier;
}

/** "1920×1080". */
export function formatSize(size: FrameSize): string {
  return `${size.width}×${size.height}`;
}

/** A scale setting in words, for while the source's size is unknown: "1.5× the source", "3840×2160", "the source size". */
export function scaleText(scale: ScaleSettings): string {
  switch (scale.mode) {
    case "factor":
      return `${scale.factor}× the source`;
    case "size":
      return `${scale.width}×${scale.height}`;
    default:
      return "the source size";
  }
}

export interface StagesInput {
  plan: JobPlan;
  /** The source's size, once GET /api/media has answered. */
  source: FrameSize | null;
  srScale: ScaleSettings;
  resize: ScaleSettings;
  /** Where frame generation takes the rate, in words ("60 fps"); unused unless it runs. */
  frameGenTarget: string;
  /** What writes the output, in words: "PNG", or the codec and container. */
  writer: string;
}

/** The plan line: what the job does, stage by stage from the decode to what writes the output. */
export function planStages({ plan, source, srScale, resize, frameGenTarget, writer }: StagesInput): string[] {
  const size = plan.outputSize ? formatSize(plan.outputSize) : null;
  const stages = [source ? `Decode ${formatSize(source)}` : "Decode"];
  if (plan.steps.includes("sr")) stages.push(`${STEP_TITLES.sr} to ${size ?? scaleText(srScale)}`);
  else if (resize.mode !== "none") stages.push(`Resize to ${size ?? scaleText(resize)}`);
  if (plan.steps.includes("nr")) stages.push(STEP_TITLES.nr);
  if (plan.steps.includes("fg")) stages.push(`${STEP_TITLES.fg} to ${frameGenTarget}`);
  stages.push(writer);
  return stages;
}
