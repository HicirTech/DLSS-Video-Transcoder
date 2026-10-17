/**
 * loadSavedSettings (web/src/hooks/useSettings.tsx): the browser's saved settings, an older build's copy moved
 * to the steps shape once, and the encode pair a v1 build saved by default (libx264 at quality 18) moved to the
 * current default.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS, DEFAULT_SR_STEP, type SettingsDefaults } from "../src/server/api-types.ts";
import { defaultSettings, loadSavedSettings, withServerDefaults } from "../web/src/hooks/useSettings.tsx";

/** What a build with one engine per job saved: its NR settings carried the warm-up, its one scale served every engine. */
function oneEngineCopy(parts: { encode?: Record<string, unknown>; scale?: Record<string, unknown>; nr?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    nr: { ...DEFAULT_NR_SETTINGS, warmupFrames: 4, ...parts.nr },
    scale: { ...DEFAULT_SCALE_SETTINGS, ...parts.scale },
    encode: { ...DEFAULT_ENCODE_SETTINGS, ...parts.encode },
    adapterUuid: null,
  });
}

const NOTHING = { v3: null, v2: null, v1: null };

describe("loadSavedSettings", () => {
  test("a browser with nothing saved starts from the defaults", () => {
    expect(loadSavedSettings(NOTHING)).toEqual(defaultSettings());
  });

  test("a v3 copy is read back as it was saved", () => {
    const saved = { ...defaultSettings(), videoSteps: { sr: true, nr: false, fg: true }, warmupFrames: 9 };
    expect(loadSavedSettings({ ...NOTHING, v3: JSON.stringify(saved) })).toEqual(saved);
  });

  test("a v2 copy's scale becomes the resize and Super Resolution's size, and its warm-up moves out of the look settings", () => {
    const settings = loadSavedSettings({ ...NOTHING, v2: oneEngineCopy({ scale: { mode: "factor", factor: 2 }, nr: { style: 2, warmupFrames: 7 } }) });
    expect(settings.resize).toEqual({ ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 2 });
    expect(settings.superResolution.scale).toEqual({ ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 2 });
    expect(settings.neuralRendering).toEqual({ ...DEFAULT_NR_SETTINGS, style: 2 });
    expect(settings.warmupFrames).toBe(7);
    expect(settings.videoSteps).toEqual(defaultSettings().videoSteps);
  });

  test("a v2 scale that kept the source size leaves Super Resolution at its default, and one Super Resolution cannot write is held to it", () => {
    expect(loadSavedSettings({ ...NOTHING, v2: oneEngineCopy() }).superResolution.scale).toEqual(DEFAULT_SR_STEP.scale);
    const shrink = loadSavedSettings({ ...NOTHING, v2: oneEngineCopy({ scale: { mode: "factor", factor: 0.5 } }) });
    expect(shrink.superResolution.scale.factor).toBe(1);
    expect(shrink.resize.factor).toBe(0.5);
  });

  test("a v1 copy that holds the old default encode pair moves to the current default", () => {
    const settings = loadSavedSettings({ ...NOTHING, v1: oneEngineCopy({ encode: { codec: "h264", quality: 18, container: "mkv", copyAudio: false } }) });
    expect(settings.encode).toEqual({ codec: DEFAULT_ENCODE_SETTINGS.codec, quality: DEFAULT_ENCODE_SETTINGS.quality, container: "mkv", copyAudio: false });
  });

  test("a v1 copy with another encode choice keeps it", () => {
    expect(loadSavedSettings({ ...NOTHING, v1: oneEngineCopy({ encode: { codec: "h264", quality: 22 } }) }).encode.codec).toBe("h264");
    expect(loadSavedSettings({ ...NOTHING, v1: oneEngineCopy({ encode: { codec: "hevc_nvenc", quality: 18 } }) }).encode.codec).toBe("hevc_nvenc");
  });

  test("the newest copy wins, and the old pair is kept as a choice once a later copy holds it", () => {
    const v2 = oneEngineCopy({ encode: { codec: "h264", quality: 18 } });
    expect(loadSavedSettings({ v3: null, v2, v1: oneEngineCopy({ encode: { codec: "av1", quality: 30 } }) }).encode).toMatchObject({ codec: "h264", quality: 18 });
    const v3 = JSON.stringify({ ...defaultSettings(), encode: { ...DEFAULT_ENCODE_SETTINGS, codec: "hevc" } });
    expect(loadSavedSettings({ v3, v2, v1: null }).encode.codec).toBe("hevc");
  });

  test("a malformed or out-of-range value falls back or is held to its range", () => {
    const settings = loadSavedSettings({
      ...NOTHING,
      v3: JSON.stringify({ videoSteps: { sr: "yes" }, frameGen: { rateBy: "speed", multiplier: 99, targetFps: "61" }, warmupFrames: -3, adapterUuid: "" }),
    });
    expect(settings.videoSteps).toEqual(defaultSettings().videoSteps);
    expect(settings.frameGen).toEqual({ ...defaultSettings().frameGen, multiplier: 16 });
    expect(settings.warmupFrames).toBe(0);
    expect(settings.adapterUuid).toBeNull();
    expect(loadSavedSettings({ ...NOTHING, v3: "{not json" })).toEqual(defaultSettings());
  });
});

describe("withServerDefaults", () => {
  test("takes every default the server has and keeps the browser's step switches and GPU", () => {
    const current = { ...defaultSettings(), videoSteps: { sr: true, nr: true, fg: true }, adapterUuid: "GPU-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2", warmupFrames: 12 };
    const defaults: SettingsDefaults = {
      superResolution: { scale: { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 2 }, motion: "flow" },
      neuralRendering: { ...DEFAULT_NR_SETTINGS, style: 1 },
      frameGen: { multiplier: 3, engine: "cascade" },
      resize: { ...DEFAULT_SCALE_SETTINGS },
      encode: { ...DEFAULT_ENCODE_SETTINGS, quality: 25 },
      warmupFrames: 4,
    };
    const merged = withServerDefaults(current, defaults);
    expect(merged.videoSteps).toEqual(current.videoSteps);
    expect(merged.adapterUuid).toBe(current.adapterUuid);
    expect(merged.superResolution).toEqual({ scale: defaults.superResolution.scale, motion: "flow" });
    expect(merged.neuralRendering.style).toBe(1);
    expect(merged.frameGen).toMatchObject({ rateBy: "multiplier", multiplier: 3, engine: "cascade" });
    expect(merged.encode.quality).toBe(25);
    expect(merged.warmupFrames).toBe(4);
  });
});
