import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EncodeSettings, FrameGenEngine, FrameGenFps, MotionKind, NrSettings, ScaleSettings, SettingsDefaults, StepKind } from "../../../src/server/api-types";
import {
  clampToRange,
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_FRAME_GEN_MULTIPLIER,
  DEFAULT_FRAME_GEN_STEP,
  DEFAULT_NR_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
  DEFAULT_SR_STEP,
  DEFAULT_WARMUP_FRAMES,
  DLSS_SR_MAX_OUTPUT_SIDE,
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  FRAME_GEN_ENGINES,
  FRAME_GEN_FPS_CHOICES,
  MOTION_KINDS,
  NR_INTENSITY_EFFECTIVE_MAX,
  NR_PRESETS,
  NR_STYLES,
  SCALE_MODES,
  SETTING_RANGES,
  SR_FACTOR_MIN,
} from "../../../src/server/api-types";
import { isRecord } from "../json";

/** Super Resolution as the forms keep it; its version folder is chosen per form and not kept. */
export interface StoredSuperResolution {
  scale: ScaleSettings;
  /** The Video tab's only: a still has no motion between frames. */
  motion: MotionKind;
}

/** How the Video tab gives frame generation its output rate. */
export const FRAME_GEN_RATE_BY = ["fps", "multiplier"] as const;

/** Frame generation as the Video tab keeps it: both ways to give the output rate, and the one in use. */
export interface StoredFrameGen {
  rateBy: (typeof FRAME_GEN_RATE_BY)[number];
  targetFps: FrameGenFps;
  multiplier: number;
  engine: FrameGenEngine;
}

/** The steps the Image tab can run: a still has no frames to generate between. */
export type ImageStepKind = Exclude<StepKind, "fg">;

/** Everything the UI persists between sessions. */
export interface StoredSettings {
  /** Which steps each tab runs. */
  videoSteps: Record<StepKind, boolean>;
  imageSteps: Record<ImageStepKind, boolean>;
  superResolution: StoredSuperResolution;
  neuralRendering: NrSettings;
  frameGen: StoredFrameGen;
  /** The resize a job without Super Resolution runs. */
  resize: ScaleSettings;
  encode: EncodeSettings;
  /** An image job's passes before the kept one (JobRequest.warmupFrames). */
  warmupFrames: number;
  /**
   * The GPU Super Resolution and Neural Rendering run on, as its CUDA device UUID from the probe
   * (JobRequest.adapterUuid); null = the server's automatic choice. A UUID because it is the one name for a
   * GPU that survives a reboot.
   */
  adapterUuid: string | null;
}

export const STORAGE_KEY = "neural-render.settings.v3";

/** Where builds that ran one engine per job kept these settings; read once, while STORAGE_KEY is empty. */
const V2_STORAGE_KEY = "neural-render.settings.v2";
/** The same shape, from builds with libx264 at quality 18 as the default encode. */
const V1_STORAGE_KEY = "neural-render.settings.v1";
const V1_DEFAULT_ENCODE = { codec: "h264", quality: 18 } as const;

export function defaultSettings(): StoredSettings {
  return {
    videoSteps: { sr: false, nr: true, fg: false },
    imageSteps: { sr: false, nr: true },
    superResolution: { scale: { ...DEFAULT_SR_STEP.scale }, motion: DEFAULT_SR_STEP.motion },
    neuralRendering: { ...DEFAULT_NR_SETTINGS },
    frameGen: { rateBy: "fps", targetFps: pick(DEFAULT_FRAME_GEN_STEP.targetFps, FRAME_GEN_FPS_CHOICES, "60"), multiplier: DEFAULT_FRAME_GEN_MULTIPLIER, engine: DEFAULT_FRAME_GEN_STEP.engine },
    resize: { ...DEFAULT_SCALE_SETTINGS },
    encode: { ...DEFAULT_ENCODE_SETTINGS },
    warmupFrames: DEFAULT_WARMUP_FRAMES,
    adapterUuid: null,
  };
}

/** Copies fields of `candidate` whose JSON type matches the default's; everything else keeps the default. */
function mergeKnown<T extends object>(base: T, candidate: unknown): T {
  if (!isRecord(candidate)) return base;
  const result: T = { ...base };
  for (const key of Object.keys(base) as Array<keyof T & string>) {
    const value = candidate[key];
    if (value === undefined) continue;
    if (typeof value === typeof base[key]) result[key] = value as T[keyof T & string];
  }
  return result;
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Confines a numeric field to the shared range for that setting, falling back to
 * the default when the stored value is not a number at all. The ranges come from
 * api-types.ts, which the server validates against, so the UI never stores a
 * value the API would reject.
 */
function clamp(value: unknown, field: keyof typeof SETTING_RANGES, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clampToRange(field, value) : fallback;
}

function repairScale(candidate: unknown, defaults: ScaleSettings): ScaleSettings {
  const scale = mergeKnown(defaults, candidate);
  return {
    mode: pick(scale.mode, SCALE_MODES, defaults.mode),
    factor: clamp(scale.factor, "factor", defaults.factor),
    width: clamp(scale.width, "width", defaults.width),
    height: clamp(scale.height, "height", defaults.height),
  };
}

function repairSuperResolution(candidate: unknown, defaults: StoredSuperResolution): StoredSuperResolution {
  const sr = isRecord(candidate) ? candidate : {};
  const scale = repairScale(sr.scale, defaults.scale);
  return {
    // Held to what Super Resolution writes as well, so a size another step allowed is not refused when the job is sent.
    scale: { ...scale, factor: Math.max(SR_FACTOR_MIN, scale.factor), width: Math.min(DLSS_SR_MAX_OUTPUT_SIDE, scale.width), height: Math.min(DLSS_SR_MAX_OUTPUT_SIDE, scale.height) },
    motion: pick(sr.motion, MOTION_KINDS, defaults.motion),
  };
}

function repairNeuralRendering(candidate: unknown, defaults: NrSettings): NrSettings {
  const nr = mergeKnown(defaults, candidate);
  return {
    ...nr,
    preset: pick(nr.preset, NR_PRESETS, defaults.preset),
    style: pick(nr.style, NR_STYLES, defaults.style),
    // The slider ends at the effective maximum, so a value stored by the older 0..2 slider is brought into its range.
    intensity: Math.min(NR_INTENSITY_EFFECTIVE_MAX, clamp(nr.intensity, "intensity", defaults.intensity)),
    localTone: clamp(nr.localTone, "localTone", defaults.localTone),
    localStructure: clamp(nr.localStructure, "localStructure", defaults.localStructure),
    skinStructure: clamp(nr.skinStructure, "skinStructure", defaults.skinStructure),
    // Not offered in the UI any more (the runtime ignores it), so a value stored by an older build is not carried on.
    uiCorrection: defaults.uiCorrection,
  };
}

function repairFrameGen(candidate: unknown, defaults: StoredFrameGen): StoredFrameGen {
  const fg = mergeKnown(defaults, candidate);
  return {
    rateBy: pick(fg.rateBy, FRAME_GEN_RATE_BY, defaults.rateBy),
    targetFps: pick(fg.targetFps, FRAME_GEN_FPS_CHOICES, defaults.targetFps),
    multiplier: clamp(fg.multiplier, "multiplier", defaults.multiplier),
    engine: pick(fg.engine, FRAME_GEN_ENGINES, defaults.engine),
  };
}

function repairEncode(candidate: unknown, defaults: EncodeSettings): EncodeSettings {
  const encode = mergeKnown(defaults, candidate);
  return {
    ...encode,
    codec: pick(encode.codec, ENCODE_CODECS, defaults.codec),
    container: pick(encode.container, ENCODE_CONTAINERS, defaults.container),
    quality: clamp(encode.quality, "quality", defaults.quality),
  };
}

/** The settings from their parts as some build or the server gave them, each repaired: anything missing, malformed or out of range takes the default. */
function repair(parts: { [K in keyof StoredSettings]?: unknown }): StoredSettings {
  const defaults = defaultSettings();
  return {
    videoSteps: mergeKnown(defaults.videoSteps, parts.videoSteps),
    imageSteps: mergeKnown(defaults.imageSteps, parts.imageSteps),
    superResolution: repairSuperResolution(parts.superResolution, defaults.superResolution),
    neuralRendering: repairNeuralRendering(parts.neuralRendering, defaults.neuralRendering),
    frameGen: repairFrameGen(parts.frameGen, defaults.frameGen),
    resize: repairScale(parts.resize, defaults.resize),
    encode: repairEncode(parts.encode, defaults.encode),
    warmupFrames: clamp(parts.warmupFrames, "warmupFrames", defaults.warmupFrames),
    adapterUuid: typeof parts.adapterUuid === "string" && parts.adapterUuid !== "" ? parts.adapterUuid : null,
  };
}

/** The JSON object `raw` holds, or null when it holds none. */
function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Parses the persisted JSON, repairing anything missing, malformed or out of range. */
export function loadSettings(raw: string | null): StoredSettings {
  return repair(parseRecord(raw) ?? {});
}

/**
 * Settings a build that ran one engine per job saved (v2, and v1 before it). Their one output size served
 * whichever engine ran, so it becomes the resize, and Super Resolution's size too unless it kept the source size
 * (which Super Resolution now runs as DLAA); the warm-up frames sat in the Neural Rendering settings.
 */
function fromOneEngineSettings(saved: Record<string, unknown>): StoredSettings {
  const nr = isRecord(saved.nr) ? saved.nr : {};
  const scale = isRecord(saved.scale) ? saved.scale : undefined;
  return repair({
    superResolution: scale && scale.mode !== "none" ? { scale } : undefined,
    neuralRendering: nr,
    resize: scale,
    encode: saved.encode,
    warmupFrames: nr.warmupFrames,
    adapterUuid: saved.adapterUuid,
  });
}

/** What this browser keeps under each key a build has used, newest first; null where it keeps nothing. */
export interface SavedCopies {
  v3: string | null;
  v2: string | null;
  v1: string | null;
}

/**
 * The settings this browser saved: STORAGE_KEY's copy, or, the first time, the newest older copy. Every page
 * load saved the whole set, so a v1 copy holds the old default encode pair whether or not anyone chose it; that
 * pair moves to the current default, once.
 */
export function loadSavedSettings(saved: SavedCopies): StoredSettings {
  if (saved.v3 !== null) return loadSettings(saved.v3);
  if (saved.v2 !== null) return fromOneEngineSettings(parseRecord(saved.v2) ?? {});
  const settings = fromOneEngineSettings(parseRecord(saved.v1) ?? {});
  const { codec, quality } = settings.encode;
  if (codec !== V1_DEFAULT_ENCODE.codec || quality !== V1_DEFAULT_ENCODE.quality) return settings;
  return { ...settings, encode: { ...settings.encode, codec: DEFAULT_ENCODE_SETTINGS.codec, quality: DEFAULT_ENCODE_SETTINGS.quality } };
}

/**
 * `current` with the server's defaults (GET /api/settings/defaults) for every setting it has one for. The steps
 * each tab runs and the GPU are this browser's own choices, so they stay.
 */
export function withServerDefaults(current: StoredSettings, defaults: SettingsDefaults): StoredSettings {
  return repair({
    videoSteps: current.videoSteps,
    imageSteps: current.imageSteps,
    superResolution: defaults.superResolution,
    neuralRendering: defaults.neuralRendering,
    frameGen: {
      rateBy: defaults.frameGen.targetFps !== undefined ? "fps" : "multiplier",
      targetFps: defaults.frameGen.targetFps,
      multiplier: defaults.frameGen.multiplier,
      engine: defaults.frameGen.engine,
    },
    resize: defaults.resize,
    encode: defaults.encode,
    warmupFrames: defaults.warmupFrames,
    adapterUuid: current.adapterUuid,
  });
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage unavailable (private mode / quota): settings simply stay in memory
  }
}

export interface SettingsStore {
  settings: StoredSettings;
  /** Replaces the parts `patch` names and keeps the rest. */
  update(patch: Partial<StoredSettings>): void;
  replaceAll(next: StoredSettings): void;
  /** Back to the DEFAULT_* constants of the API contract. */
  reset(): void;
}

const SettingsContext = createContext<SettingsStore | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<StoredSettings>(() =>
    loadSavedSettings({ v3: readStorage(STORAGE_KEY), v2: readStorage(V2_STORAGE_KEY), v1: readStorage(V1_STORAGE_KEY) }),
  );

  useEffect(() => {
    writeStorage(JSON.stringify(settings));
  }, [settings]);

  const store = useMemo<SettingsStore>(
    () => ({
      settings,
      update: (patch) => setSettings((current) => ({ ...current, ...patch })),
      replaceAll: (next) => setSettings(next),
      reset: () => setSettings(defaultSettings()),
    }),
    [settings],
  );

  return <SettingsContext.Provider value={store}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsStore {
  const store = useContext(SettingsContext);
  if (!store) throw new Error("useSettings must be used inside <SettingsProvider>");
  return store;
}
