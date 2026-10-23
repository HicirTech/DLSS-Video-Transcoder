/**
 * Request validation for the job API. Pure and free of `Bun.serve`, so it is
 * unit-testable; main.ts adds the checks that need the filesystem. It imports no
 * Node module, because the mock backends in web/ call it too.
 *
 * The limits come from api-types.ts, which the web UI clamps to as well, so a
 * value the UI sends is never rejected here; the UI may offer less (intensity up
 * to NR_INTENSITY_EFFECTIVE_MAX, no uiCorrection, only the named
 * FRAME_GEN_FPS_CHOICES rates).
 */
import { DEVICE_UUID_GROUP_LENGTHS, DEVICE_UUID_PATTERN } from "../native/device-uuid.ts";
import { resolveTargetRate } from "../pipeline/framegen-plan.ts";
import {
  DEFAULT_ENCODE_SETTINGS,
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  FRAME_GEN_CONTAINER,
  FRAME_GEN_ENGINES,
  FRAME_GEN_GPU_CHOICE,
  JOB_KINDS,
  MOTION_KINDS,
  NR_PRESETS,
  NR_STYLES,
  SCALE_MODES,
  SETTING_RANGES,
  SR_FACTOR_MIN,
  stepsPresent,
  type JobRequest,
  type ScaleSettings,
} from "./api-types.ts";
import { srSideProblem } from "./output-size.ts";
import { takesGpuChoice } from "./settings-in-use.ts";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `<field> must be …` when the value is out of range, else null. */
function checkNumber(value: unknown, field: keyof typeof SETTING_RANGES, path: string): string | null {
  const { min, max, integer } = SETTING_RANGES[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number between ${min} and ${max}.`;
  if (integer && !Number.isInteger(value)) return `${path} must be a whole number between ${min} and ${max}.`;
  if (value < min || value > max) return `${path} must be between ${min} and ${max} (got ${value}).`;
  return null;
}

function checkEnum<T extends readonly (string | number)[]>(value: unknown, allowed: T, path: string): string | null {
  return allowed.includes(value as T[number]) ? null : `${path} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)}).`;
}

function checkBoolean(value: unknown, path: string): string | null {
  return typeof value === "boolean" ? null : `${path} must be true or false.`;
}

function first(...checks: Array<string | null>): string | null {
  return checks.find((c) => c !== null) ?? null;
}

/** A step's version folder has to be a string; main.ts checks it against the catalog. */
function checkDllDirType(step: Record<string, unknown>, path: string): string | null {
  return step.dllDir === undefined || typeof step.dllDir === "string" ? null : `${path}.dllDir must be a string when present.`;
}

function checkScale(value: unknown, path: string): string | null {
  if (!isObject(value)) return `${path} must be an object.`;
  return first(
    checkEnum(value.mode, SCALE_MODES, `${path}.mode`),
    checkNumber(value.factor, "factor", `${path}.factor`),
    checkNumber(value.width, "width", `${path}.width`),
    checkNumber(value.height, "height", `${path}.height`),
  );
}

function checkNrSettings(value: unknown, path: string): string | null {
  if (!isObject(value)) return `${path} must be an object.`;
  return first(
    checkEnum(value.preset, NR_PRESETS, `${path}.preset`),
    checkEnum(value.style, NR_STYLES, `${path}.style`),
    checkNumber(value.intensity, "intensity", `${path}.intensity`),
    checkNumber(value.localTone, "localTone", `${path}.localTone`),
    checkNumber(value.localStructure, "localStructure", `${path}.localStructure`),
    checkNumber(value.skinStructure, "skinStructure", `${path}.skinStructure`),
    checkBoolean(value.autoMask, `${path}.autoMask`),
    checkBoolean(value.uiCorrection, `${path}.uiCorrection`),
  );
}

/**
 * DLSS SR only enlarges and writes no side past DLSS_SR_MAX_OUTPUT_SIDE (srOutputProblem). A factor below
 * SR_FACTOR_MIN and an exact size past that side (srSideProblem) are refused before the job queues; an output
 * smaller than the source needs the source's size, so the job refuses it when it opens SR.
 */
function checkSuperResolution(step: unknown, kind: unknown): string | null {
  if (!isObject(step)) return "superResolution must be an object when present.";
  const problem = first(
    checkScale(step.scale, "superResolution.scale"),
    step.motion === undefined ? null : checkEnum(step.motion, MOTION_KINDS, "superResolution.motion"),
    checkDllDirType(step, "superResolution"),
  );
  if (problem) return problem;
  const scale = step.scale as ScaleSettings; // checkScale has passed
  if (scale.mode === "factor" && scale.factor < SR_FACTOR_MIN) {
    return `Super Resolution only enlarges: superResolution.scale.factor must be at least ${SR_FACTOR_MIN} (got ${scale.factor}; 1 runs DLAA at the source size). Use resize without superResolution to shrink.`;
  }
  if (scale.mode === "size") {
    const sideProblem = srSideProblem(scale);
    if (sideProblem) return sideProblem;
  }
  // A still has no frames to estimate motion between, and the image job never reads it.
  if (kind === "image" && step.motion === "flow") return 'superResolution.motion applies to video jobs only; omit it or set it to "none".';
  return null;
}

function checkNeuralRendering(step: unknown): string | null {
  if (!isObject(step)) return "neuralRendering must be an object when present.";
  return first(checkNrSettings(step.settings, "neuralRendering.settings"), checkDllDirType(step, "neuralRendering"));
}

function checkFrameGen(step: unknown, kind: unknown): string | null {
  // A still image has no frames to interpolate between.
  if (kind !== "video") return "frameGen applies to video jobs only.";
  if (!isObject(step)) return "frameGen must be an object when present.";
  if (step.multiplier === undefined && step.targetFps === undefined) return "frameGen needs targetFps or multiplier — otherwise the job has no output rate to aim for.";
  if (step.multiplier !== undefined) {
    const wrongMultiplier = checkNumber(step.multiplier, "multiplier", "frameGen.multiplier");
    if (wrongMultiplier) return wrongMultiplier;
  }
  if (step.targetFps !== undefined) {
    if (typeof step.targetFps !== "string") return "frameGen.targetFps must be a string, e.g. \"120\" or \"60000/1001\".";
    // Resolved here rather than at typeof: the planner owns which rates exist,
    // and rejecting a bad one now beats queueing a job that fails minutes later
    // inside the pipeline with a message about BigInt arithmetic.
    try {
      resolveTargetRate(step.targetFps);
    } catch (error) {
      return `frameGen.targetFps is not a rate this build can produce: ${(error as Error).message}`;
    }
  }
  return first(step.engine === undefined ? null : checkEnum(step.engine, FRAME_GEN_ENGINES, "frameGen.engine"), checkDllDirType(step, "frameGen"));
}

/** Frame generation writes FRAME_GEN_CONTAINER only, so a request must not ask for another container. */
function checkFrameGenContainer(v: Record<string, unknown>): string | null {
  if (isObject(v.encode) && v.encode.container !== FRAME_GEN_CONTAINER) {
    return `Frame generation writes ${FRAME_GEN_CONTAINER} only; set encode.container to "${FRAME_GEN_CONTAINER}" (got ${JSON.stringify(v.encode.container)}).`;
  }
  return null;
}

/**
 * An explicit output has to end in the extension of what the job writes: ffmpeg picks the muxer from the name, so
 * another one would quietly not honour encode.container, and an image job writes PNG whatever the name says.
 */
function checkOutputExtension(v: Record<string, unknown>): string | null {
  if (typeof v.output !== "string") return null;
  const endsWith = (extension: string): boolean => (v.output as string).toLowerCase().endsWith(`.${extension}`);
  if (v.kind === "image") return endsWith("png") ? null : "output must end in .png: an image job writes PNG; rename it or omit it.";
  if (v.frameGen !== undefined) {
    return endsWith(FRAME_GEN_CONTAINER) ? null : `Frame generation writes ${FRAME_GEN_CONTAINER} only; give the output path a .${FRAME_GEN_CONTAINER} extension or omit it.`;
  }
  const container = isObject(v.encode) ? String(v.encode.container) : DEFAULT_ENCODE_SETTINGS.container;
  return endsWith(container) ? null : `output must end in .${container}, the encode.container this job writes; rename it or set encode.container to match.`;
}

/** A resize is the job's own size change; Super Resolution sets the output size itself. */
function checkResize(v: Record<string, unknown>): string | null {
  if (v.superResolution !== undefined) return "resize does not apply with superResolution, which sets the output size itself; omit it.";
  return checkScale(v.resize, "resize");
}

function checkWarmupFrames(v: Record<string, unknown>): string | null {
  if (v.kind !== "image") return "warmupFrames applies to image jobs only.";
  return checkNumber(v.warmupFrames, "warmupFrames", "warmupFrames");
}

function checkEncode(value: unknown, kind: unknown): string | null {
  // An image job writes a PNG and never reads encode settings.
  if (kind !== "video") return "encode applies to video jobs only.";
  if (!isObject(value)) return "encode must be an object when present.";
  return first(
    checkEnum(value.codec, ENCODE_CODECS, "encode.codec"),
    checkEnum(value.container, ENCODE_CONTAINERS, "encode.container"),
    checkNumber(value.quality, "quality", "encode.quality"),
    checkBoolean(value.copyAudio, "encode.copyAudio"),
  );
}

function checkAdapterUuid(v: Record<string, unknown>): string | null {
  if (typeof v.adapterUuid !== "string" || !DEVICE_UUID_PATTERN.test(v.adapterUuid)) {
    return `adapterUuid must be a CUDA device UUID as GET /api/probe lists it ("GPU-" followed by ${DEVICE_UUID_GROUP_LENGTHS.join("-")} hex digits).`;
  }
  // Frame generation picks its GPU in its host process (README, "Shared options"); the choice reaches only SR and NR.
  if (!takesGpuChoice(stepsPresent(v))) {
    return `adapterUuid applies to Super Resolution and Neural Rendering; frame generation picks its GPU itself (${FRAME_GEN_GPU_CHOICE}). Omit it.`;
  }
  return null;
}

/** The request fields the step objects replaced: accepting one would run a different job than the client asked for. */
const REPLACED_FIELDS = ["engine", "motion", "scale", "settings", "dllDir"] as const;

/**
 * Validates a POST /api/jobs body. Returns null when it is a usable JobRequest,
 * otherwise a message naming the offending field and what it accepts — the
 * caller returns that to the client verbatim.
 */
export function validateJobRequest(value: unknown): string | null {
  if (!isObject(value)) return "Request body must be a JSON object.";
  const v = value;
  const wrongKind = checkEnum(v.kind, JOB_KINDS, "kind");
  if (wrongKind) return wrongKind;
  if (typeof v.input !== "string" || v.input === "") return "input must be a non-empty absolute path.";
  if (v.output !== undefined && typeof v.output !== "string") return "output must be a string when present.";
  const replaced = REPLACED_FIELDS.filter((field) => field in v);
  if (replaced.length) {
    return `${replaced.join(", ")} ${replaced.length === 1 ? "is" : "are"} no longer part of a job: give each step its own object (superResolution, neuralRendering, frameGen) and resize for a plain resize.`;
  }
  return first(
    v.superResolution === undefined ? null : checkSuperResolution(v.superResolution, v.kind),
    v.neuralRendering === undefined ? null : checkNeuralRendering(v.neuralRendering),
    v.frameGen === undefined ? null : checkFrameGen(v.frameGen, v.kind),
    v.frameGen === undefined ? null : checkFrameGenContainer(v),
    v.resize === undefined ? null : checkResize(v),
    v.encode === undefined ? null : checkEncode(v.encode, v.kind),
    // After checkEncode, so an unknown container is reported as one rather than as a wrong extension.
    checkOutputExtension(v),
    v.warmupFrames === undefined ? null : checkWarmupFrames(v),
    v.adapterUuid === undefined ? null : checkAdapterUuid(v),
  );
}

/** Narrowing wrapper for callers that have already validated. */
export function asJobRequest(value: unknown): JobRequest {
  return value as JobRequest;
}
