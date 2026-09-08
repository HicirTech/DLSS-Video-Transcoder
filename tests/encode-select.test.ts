import { describe, expect, test } from "bun:test";
import { cpuSiblingCodec, isNvenc, preferredDefaultCodec, resolveEncodeCodec } from "../src/pipeline/encode-select.ts";

describe("encode-select", () => {
  test("isNvenc identifies the hardware encoders", () => {
    expect(isNvenc("h264_nvenc")).toBe(true);
    expect(isNvenc("hevc_nvenc")).toBe(true);
    expect(isNvenc("av1_nvenc")).toBe(true);
    expect(isNvenc("h264")).toBe(false);
    expect(isNvenc("hevc")).toBe(false);
    expect(isNvenc("av1")).toBe(false);
  });

  test("cpuSiblingCodec maps NVENC to the matching CPU codec and leaves CPU codecs alone", () => {
    expect(cpuSiblingCodec("h264_nvenc")).toBe("h264");
    expect(cpuSiblingCodec("hevc_nvenc")).toBe("hevc");
    expect(cpuSiblingCodec("av1_nvenc")).toBe("av1");
    expect(cpuSiblingCodec("h264")).toBe("h264");
    expect(cpuSiblingCodec("av1")).toBe("av1");
  });

  test("preferredDefaultCodec picks GPU when available", () => {
    expect(preferredDefaultCodec(true)).toBe("h264_nvenc");
    expect(preferredDefaultCodec(false)).toBe("h264");
  });

  test("resolveEncodeCodec passes CPU codecs through without probing", () => {
    // A CPU codec returns as-is and never spawns ffmpeg, so a bogus path is fine.
    expect(resolveEncodeCodec("h264", "C:/nonexistent/ffmpeg.exe")).toEqual({ codec: "h264", note: null });
    expect(resolveEncodeCodec("av1", "C:/nonexistent/ffmpeg.exe")).toEqual({ codec: "av1", note: null });
  });

  test("resolveEncodeCodec falls back to the CPU sibling when the NVENC probe cannot run", () => {
    // A bogus ffmpeg path makes the probe throw/fail, exercising the fallback branch.
    const resolved = resolveEncodeCodec("hevc_nvenc", "C:/nonexistent/ffmpeg.exe");
    expect(resolved.codec).toBe("hevc");
    expect(resolved.note).toContain("hevc_nvenc");
  });
});
