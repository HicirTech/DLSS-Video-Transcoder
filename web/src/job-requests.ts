/**
 * The JobRequest each form sends, built from what the form shows: the steps switched on with their stored
 * settings, and the form's own fields. Only what the job runs goes in, so a request never carries a step's
 * settings with the step switched off.
 */
import type { FrameGenStep, JobRequest, StepKind } from "../../src/server/api-types";
import { takesGpuChoice } from "../../src/server/settings-in-use";
import { videoContainer } from "./job-plan";
import type { StoredFrameGen, StoredSettings } from "./stored-settings";

/** What a form holds itself rather than in the stored settings. */
export interface FormFields {
  input: string;
  /** Empty for the default name next to the input. */
  output: string;
  /** A version folder per step from GET /api/catalog; empty or absent for the bundled DLL. */
  dllDirs: Partial<Record<StepKind, string>>;
}

export function videoRequest(form: FormFields, settings: StoredSettings): JobRequest {
  const steps = settings.videoSteps;
  const request: JobRequest = { kind: "video", input: form.input.trim() };
  if (steps.sr) request.superResolution = { scale: settings.superResolution.scale, motion: settings.superResolution.motion, ...dllDirOf(form, "sr") };
  if (steps.nr) request.neuralRendering = { settings: settings.neuralRendering, ...dllDirOf(form, "nr") };
  if (steps.fg) request.frameGen = { ...rateFields(settings.frameGen), engine: settings.frameGen.engine, ...dllDirOf(form, "fg") };
  if (!steps.sr && settings.resize.mode !== "none") request.resize = settings.resize;
  // Frame generation writes one container; the stored choice comes back when it is switched off.
  request.encode = { ...settings.encode, container: videoContainer(steps, settings.encode.container) };
  // Frame generation picks its GPU in its host process, so a job that runs it alone is sent no GPU choice.
  if (settings.adapterUuid && takesGpuChoice(steps)) request.adapterUuid = settings.adapterUuid;
  if (form.output.trim() !== "") request.output = form.output.trim();
  return request;
}

export function imageRequest(form: FormFields, settings: StoredSettings): JobRequest {
  const steps = settings.imageSteps;
  const request: JobRequest = { kind: "image", input: form.input.trim(), warmupFrames: settings.warmupFrames };
  // A still has no motion between frames, so Super Resolution gets no motion setting.
  if (steps.sr) request.superResolution = { scale: settings.superResolution.scale, ...dllDirOf(form, "sr") };
  if (steps.nr) request.neuralRendering = { settings: settings.neuralRendering, ...dllDirOf(form, "nr") };
  if (!steps.sr && settings.resize.mode !== "none") request.resize = settings.resize;
  if (settings.adapterUuid) request.adapterUuid = settings.adapterUuid;
  if (form.output.trim() !== "") request.output = form.output.trim();
  return request;
}

/** The step's dllDir field when the form chose a version, else no field: the job loads the bundled DLL. */
function dllDirOf(form: FormFields, step: StepKind): { dllDir?: string } {
  const dir = form.dllDirs[step];
  return dir ? { dllDir: dir } : {};
}

/** The one rate field the stored choice gives: the API takes targetFps over multiplier when both are sent. */
function rateFields(frameGen: StoredFrameGen): Pick<FrameGenStep, "targetFps" | "multiplier"> {
  return frameGen.rateBy === "fps" ? { targetFps: frameGen.targetFps } : { multiplier: frameGen.multiplier };
}
