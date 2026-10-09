/**
 * loadSavedSettings (web/src/hooks/useSettings.tsx): the browser's saved settings, with the encode pair an
 * older build saved by default (libx264 at quality 18) moved to the current default once.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_ENCODE_SETTINGS } from "../src/server/api-types.ts";
import { defaultSettings, loadSavedSettings } from "../web/src/hooks/useSettings.tsx";

function saved(encode: Record<string, unknown>): string {
  return JSON.stringify({ ...defaultSettings(), encode: { ...DEFAULT_ENCODE_SETTINGS, ...encode } });
}

describe("loadSavedSettings", () => {
  test("a v1 copy that holds the old default encode pair moves to the current default", () => {
    const settings = loadSavedSettings(null, saved({ codec: "h264", quality: 18, container: "mkv", copyAudio: false }));
    expect(settings.encode).toEqual({ codec: DEFAULT_ENCODE_SETTINGS.codec, quality: DEFAULT_ENCODE_SETTINGS.quality, container: "mkv", copyAudio: false });
  });

  test("a v1 copy with another encode choice keeps it", () => {
    expect(loadSavedSettings(null, saved({ codec: "h264", quality: 22 })).encode.codec).toBe("h264");
    expect(loadSavedSettings(null, saved({ codec: "hevc_nvenc", quality: 18 })).encode.codec).toBe("hevc_nvenc");
  });

  test("once the current key holds settings, the old pair is kept as a choice", () => {
    const settings = loadSavedSettings(saved({ codec: "h264", quality: 18 }), saved({ codec: "av1", quality: 30 }));
    expect(settings.encode).toMatchObject({ codec: "h264", quality: 18 });
  });

  test("a browser with nothing saved starts from the defaults", () => {
    expect(loadSavedSettings(null, null)).toEqual(defaultSettings());
  });
});
