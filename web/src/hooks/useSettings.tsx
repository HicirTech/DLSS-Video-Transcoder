import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EncodeSettings, NrSettings, ScaleSettings } from "../../../src/server/api-types";
import {
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_NR_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
  ENCODE_CODECS,
  ENCODE_CONTAINERS,
  NR_INTENSITY_EFFECTIVE_MAX,
  NR_PRESETS,
  NR_STYLES,
  SCALE_MODES,
  SETTING_RANGES,
} from "../../../src/server/api-types";

/** Everything the UI persists between sessions. */
export interface StoredSettings {
  nr: NrSettings;
  scale: ScaleSettings;
  encode: EncodeSettings;
  /**
   * The GPU image and video jobs run on, as its CUDA device UUID from the probe
   * (JobRequest.adapterUuid); null = the server's automatic choice. A UUID
   * because it is the one name for a GPU that survives a reboot.
   */
  adapterUuid: string | null;
}

export const STORAGE_KEY = "neural-render.settings.v1";

export function defaultSettings(): StoredSettings {
  return {
    nr: { ...DEFAULT_NR_SETTINGS },
    scale: { ...DEFAULT_SCALE_SETTINGS },
    encode: { ...DEFAULT_ENCODE_SETTINGS },
    adapterUuid: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
function clamp(value: number, field: keyof typeof SETTING_RANGES, fallback: number): number {
  const { min, max, integer } = SETTING_RANGES[field];
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, integer ? Math.round(value) : value));
}

/** Parses the persisted JSON, repairing anything missing, malformed or out of range. */
export function loadSettings(raw: string | null): StoredSettings {
  const defaults = defaultSettings();
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!isRecord(parsed)) return defaults;
  const nr = mergeKnown(defaults.nr, parsed.nr);
  const scale = mergeKnown(defaults.scale, parsed.scale);
  const encode = mergeKnown(defaults.encode, parsed.encode);
  return {
    nr: {
      ...nr,
      preset: pick(nr.preset, NR_PRESETS, defaults.nr.preset),
      style: pick(nr.style, NR_STYLES, defaults.nr.style),
      // The slider ends at the effective maximum, so a value stored by the older 0..2 slider is brought into its range.
      intensity: Math.min(NR_INTENSITY_EFFECTIVE_MAX, clamp(nr.intensity, "intensity", defaults.nr.intensity)),
      localTone: clamp(nr.localTone, "localTone", defaults.nr.localTone),
      localStructure: clamp(nr.localStructure, "localStructure", defaults.nr.localStructure),
      skinStructure: clamp(nr.skinStructure, "skinStructure", defaults.nr.skinStructure),
      // Not offered in the UI any more (the runtime ignores it), so a value stored by an older build is not carried on.
      uiCorrection: defaults.nr.uiCorrection,
      warmupFrames: clamp(nr.warmupFrames, "warmupFrames", defaults.nr.warmupFrames),
    },
    scale: {
      ...scale,
      mode: pick(scale.mode, SCALE_MODES, defaults.scale.mode),
      factor: clamp(scale.factor, "factor", defaults.scale.factor),
      width: clamp(scale.width, "width", defaults.scale.width),
      height: clamp(scale.height, "height", defaults.scale.height),
    },
    encode: {
      ...encode,
      codec: pick(encode.codec, ENCODE_CODECS, defaults.encode.codec),
      container: pick(encode.container, ENCODE_CONTAINERS, defaults.encode.container),
      quality: clamp(encode.quality, "quality", defaults.encode.quality),
    },
    adapterUuid: typeof parsed.adapterUuid === "string" && parsed.adapterUuid !== "" ? parsed.adapterUuid : null,
  };
}

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
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
  setNr(nr: NrSettings): void;
  setScale(scale: ScaleSettings): void;
  setEncode(encode: EncodeSettings): void;
  setAdapterUuid(adapterUuid: string | null): void;
  replaceAll(next: StoredSettings): void;
  /** Back to the DEFAULT_* constants of the API contract. */
  reset(): void;
}

const SettingsContext = createContext<SettingsStore | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings(readStorage()));

  useEffect(() => {
    writeStorage(JSON.stringify(settings));
  }, [settings]);

  const store = useMemo<SettingsStore>(
    () => ({
      settings,
      setNr: (nr) => setSettings((current) => ({ ...current, nr })),
      setScale: (scale) => setSettings((current) => ({ ...current, scale })),
      setEncode: (encode) => setSettings((current) => ({ ...current, encode })),
      setAdapterUuid: (adapterUuid) => setSettings((current) => ({ ...current, adapterUuid })),
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
