/**
 * Which settings of a job request take effect, from the job's engine and whether it runs frame generation:
 * the one statement of it. The web forms disable what a job ignores and show the reason beside it; the
 * server checks a dllDir against the DLL feature the job loads. It imports no Node module: the web bundles it.
 */
import { DLSS_SR_MAX_OUTPUT_SIDE, ENGINE_USES_MOTION, type EngineKind, FRAME_GEN_GPU_CHOICE, type JobRequest, SR_FACTOR_MIN } from "./api-types.ts";

/** What decides which settings a job uses. */
export interface JobShape {
  engine: EngineKind;
  /** Whether the job runs frame generation, which runs none of the per-frame engines. */
  frameGen: boolean;
}

/** The shape of a request the server received. */
export function jobShapeOf(request: Pick<JobRequest, "engine" | "frameGen">): JobShape {
  return { engine: request.engine, frameGen: request.frameGen !== undefined };
}

/** The DLSS feature a job loads a DLL of, the one its dllDir has to be a version of. */
export type DllFeature = "sr" | "nr" | "fg";

/** The feature of the DLL a job loads, or null for a bypass job without frame generation, which loads none. */
export function dllFeatureOf(job: JobShape): DllFeature | null {
  if (job.frameGen) return "fg";
  return job.engine === "bypass" ? null : job.engine;
}

/**
 * For each group of settings, null when the job uses it, otherwise the reason it does not, in the words the
 * form shows beside the disabled controls.
 */
export interface UnusedSettings {
  engine: string | null;
  motion: string | null;
  outputSize: string | null;
  /** The Neural Rendering look settings: style, intensity, local tone and structure, the masks. */
  nrLook: string | null;
  /** The GPU chosen in the Settings tab. */
  gpu: string | null;
}

const FRAME_GEN_ONLY = "Frame generation only interpolates: it runs neither Super Resolution nor Neural Rendering and keeps the source size.";

/** What a reason calls each engine, at the start of a sentence. */
const ENGINE_NAME: Record<EngineKind, string> = { sr: "Super Resolution", nr: "Neural Rendering", bypass: "The bypass engine" };

/** Why the look settings do nothing for an engine other than nr. */
const LOOK_UNUSED: Record<Exclude<EngineKind, "nr">, string> = {
  sr: "Super Resolution has no look settings: it upscales to the output size.",
  bypass: "The bypass engine copies frames unchanged, so no look setting applies.",
};

export function unusedSettings(job: JobShape): UnusedSettings {
  if (job.frameGen) {
    return { engine: FRAME_GEN_ONLY, motion: FRAME_GEN_ONLY, outputSize: FRAME_GEN_ONLY, nrLook: FRAME_GEN_ONLY, gpu: `Frame generation picks its GPU itself: ${FRAME_GEN_GPU_CHOICE}.` };
  }
  return {
    engine: null,
    motion: ENGINE_USES_MOTION[job.engine] ? null : `${ENGINE_NAME[job.engine]} takes no motion vectors.`,
    outputSize: null,
    nrLook: job.engine === "nr" ? null : LOOK_UNUSED[job.engine],
    gpu: null,
  };
}

/** What output size an engine can write, beyond the API's own ranges (SETTING_RANGES). */
export interface OutputSizeLimits {
  /** The smallest factor. */
  factorMin: number | null;
  /** The longest side, in pixels. */
  sideMax: number | null;
  /** The limits in words, for the form's hint; null when there are none. */
  note: string | null;
}

/** Super Resolution only enlarges and has a longest side (srOutputProblem); the other engines take the API's whole range. */
export function outputSizeLimits(engine: EngineKind): OutputSizeLimits {
  if (engine !== "sr") return { factorMin: null, sideMax: null, note: null };
  return {
    factorMin: SR_FACTOR_MIN,
    sideMax: DLSS_SR_MAX_OUTPUT_SIDE,
    note: `Super Resolution only enlarges, from ${SR_FACTOR_MIN}× (DLAA at the source size), and writes at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side.`,
  };
}
