/**
 * Request validation for the job API. Pure and free of `Bun.serve`, so it is
 * unit-testable; main.ts adds the checks that need the filesystem.
 *
 * The limits come from api-types.ts, which the web UI clamps to as well, so a
 * value the UI accepts is never rejected here and vice versa.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveTargetRate } from "../pipeline/framegen-plan.ts";
import {
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  FRAME_GEN_ENGINES,
  NR_PATHS,
  NR_PRESETS,
  NR_STYLES,
  SCALE_MODES,
  SETTING_RANGES,
  type JobRequest,
} from "./api-types.ts";

/**
 * True when `child` resolves inside `root`.
 *
 * The check is on the first path segment, not a string prefix: a relative path
 * such as `..cache/out.mp4` names a child directory that merely starts with two
 * dots, and rejecting it would refuse a legitimate output path.
 */
export function isWithin(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

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

function checkNrSettings(v: Record<string, unknown>): string | null {
  return first(
    checkEnum(v.preset, NR_PRESETS, "settings.preset"),
    checkEnum(v.style, NR_STYLES, "settings.style"),
    checkEnum(v.nrPath, NR_PATHS, "settings.nrPath"),
    checkNumber(v.intensity, "intensity", "settings.intensity"),
    checkNumber(v.localTone, "localTone", "settings.localTone"),
    checkNumber(v.localStructure, "localStructure", "settings.localStructure"),
    checkNumber(v.skinStructure, "skinStructure", "settings.skinStructure"),
    checkNumber(v.warmupFrames, "warmupFrames", "settings.warmupFrames"),
    // globalTone is not applied by the current runtime, but it is part of the contract.
    v.globalTone === null || (typeof v.globalTone === "number" && Number.isFinite(v.globalTone)) ? null : "settings.globalTone must be a finite number or null.",
    checkBoolean(v.autoMask, "settings.autoMask"),
    checkBoolean(v.uiCorrection, "settings.uiCorrection"),
  );
}

function checkScale(v: Record<string, unknown>): string | null {
  return first(
    checkEnum(v.mode, SCALE_MODES, "scale.mode"),
    checkNumber(v.factor, "factor", "scale.factor"),
    checkNumber(v.width, "width", "scale.width"),
    checkNumber(v.height, "height", "scale.height"),
  );
}

function checkEncode(v: Record<string, unknown>): string | null {
  return first(
    checkEnum(v.codec, ENCODE_CODECS, "encode.codec"),
    checkEnum(v.container, ENCODE_CONTAINERS, "encode.container"),
    checkNumber(v.quality, "quality", "encode.quality"),
    checkBoolean(v.copyAudio, "encode.copyAudio"),
  );
}

function checkFrameGen(v: Record<string, unknown>): string | null {
  if (v.multiplier === undefined && v.targetFps === undefined) return "frameGen needs targetFps or multiplier — otherwise the job has no output rate to aim for.";
  if (v.multiplier !== undefined && (typeof v.multiplier !== "number" || !Number.isFinite(v.multiplier) || v.multiplier < 1)) return "frameGen.multiplier must be a finite number of at least 1.";
  if (v.targetFps !== undefined) {
    if (typeof v.targetFps !== "string") return "frameGen.targetFps must be a string, e.g. \"120\" or \"60000/1001\".";
    // Resolved here rather than at typeof: the planner owns which rates exist,
    // and rejecting a bad one now beats queueing a job that fails minutes later
    // inside the pipeline with a message about BigInt arithmetic.
    try {
      resolveTargetRate(v.targetFps);
    } catch (error) {
      return `frameGen.targetFps is not a rate this build can produce: ${(error as Error).message}`;
    }
  }
  if (v.engine !== undefined) return checkEnum(v.engine, FRAME_GEN_ENGINES, "frameGen.engine");
  return null;
}

/**
 * Validates a POST /api/jobs body. Returns null when it is a usable JobRequest,
 * otherwise a message naming the offending field and what it accepts — the
 * caller returns that to the client verbatim.
 */
export function validateJobRequest(value: unknown): string | null {
  if (!isObject(value)) return "Request body must be a JSON object.";
  const v = value;
  if (v.kind !== "image" && v.kind !== "video") return 'kind must be "image" or "video".';
  if (typeof v.input !== "string" || v.input === "") return "input must be a non-empty absolute path.";
  if (v.output !== undefined && typeof v.output !== "string") return "output must be a string when present.";
  if (v.engine !== "bypass" && v.engine !== "nr" && v.engine !== "sr") return 'engine must be "sr", "nr" or "bypass".';
  if (v.motion !== "none" && v.motion !== "flow") return 'motion must be "none" or "flow".';
  if (v.dllDir !== undefined && typeof v.dllDir !== "string") return "dllDir must be a string when present.";
  if (!isObject(v.settings)) return "settings must be an object.";
  if (!isObject(v.scale)) return "scale must be an object.";
  const problem = first(
    checkNrSettings(v.settings),
    checkScale(v.scale),
    v.encode === undefined ? null : isObject(v.encode) ? checkEncode(v.encode) : "encode must be an object when present.",
    // A still image has no frames to interpolate between, and the image worker
    // never reads frameGen, so accepting it would silently drop the request.
    v.frameGen !== undefined && v.kind !== "video" ? "frameGen applies to video jobs only." : null,
    v.frameGen === undefined ? null : isObject(v.frameGen) ? checkFrameGen(v.frameGen) : "frameGen must be an object when present.",
  );
  return problem;
}

/** Narrowing wrapper for callers that have already validated. */
export function asJobRequest(value: unknown): JobRequest {
  return value as JobRequest;
}
