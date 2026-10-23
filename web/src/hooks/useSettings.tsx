/**
 * The settings store: StoredSettings kept in localStorage between sessions (an older build's copy is read once), and
 * the context provider and hook the forms read and change them through.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SettingsDefaults } from "../../../src/server/api-types";
import { defaultSettings, loadSavedSettings, type StoredSettings, withServerDefaults } from "../stored-settings";

export const STORAGE_KEY = "neural-render.settings.v3";

/** Where builds that ran one engine per job kept these settings; read once, while STORAGE_KEY is empty. */
const V2_STORAGE_KEY = "neural-render.settings.v2";
/** The same shape, from builds with libx264 at quality 18 as the default encode. */
const V1_STORAGE_KEY = "neural-render.settings.v1";

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
  /** Takes the server's defaults, keeping the step switches and the GPU stored at the moment they are applied. */
  applyServerDefaults(defaults: SettingsDefaults): void;
  /** Back to defaultSettings(), the step switches and the GPU choice included. */
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
      applyServerDefaults: (defaults) => setSettings((current) => withServerDefaults(current, defaults)),
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
