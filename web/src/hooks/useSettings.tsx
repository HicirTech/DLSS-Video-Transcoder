import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EncodeSettings, NrSettings, ScaleSettings } from "../../../src/server/api-types";
import {
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_NR_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
} from "../../../src/server/api-types";

/** Everything the UI persists between sessions. */
export interface StoredSettings {
  nr: NrSettings;
  scale: ScaleSettings;
  encode: EncodeSettings;
}

export const STORAGE_KEY = "neural-render.settings.v1";

export function defaultSettings(): StoredSettings {
  return {
    nr: { ...DEFAULT_NR_SETTINGS },
    scale: { ...DEFAULT_SCALE_SETTINGS },
    encode: { ...DEFAULT_ENCODE_SETTINGS },
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
    const baseValue = base[key];
    const accepted =
      baseValue === null ? value === null || typeof value === "number" : typeof value === typeof baseValue;
    if (accepted) result[key] = value as T[keyof T & string];
  }
  return result;
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const PRESETS = [0, 1, 2, 3] as const;
const STYLES = [0, 1, 2] as const;
const NR_PATHS = ["auto", "core", "snippet"] as const;
const SCALE_MODES = ["none", "factor", "size"] as const;
const CODECS = ["h264", "hevc", "av1", "h264_nvenc", "hevc_nvenc", "av1_nvenc"] as const;
const CONTAINERS = ["mp4", "mkv", "mov"] as const;

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
      preset: pick(nr.preset, PRESETS, defaults.nr.preset),
      style: pick(nr.style, STYLES, defaults.nr.style),
      nrPath: pick(nr.nrPath, NR_PATHS, defaults.nr.nrPath),
      warmupFrames: Math.max(0, Math.round(nr.warmupFrames)),
    },
    scale: { ...scale, mode: pick(scale.mode, SCALE_MODES, defaults.scale.mode) },
    encode: {
      ...encode,
      codec: pick(encode.codec, CODECS, defaults.encode.codec),
      container: pick(encode.container, CONTAINERS, defaults.encode.container),
    },
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
