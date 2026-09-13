import { describe, expect, test } from "bun:test";
import { buildNvencProbeArgs, cpuSiblingCodec, isNvenc, nvencGpuArgs, preferredDefaultCodec, resolveEncodeCodec } from "../src/pipeline/encode-select.ts";
import { encoderArgs } from "../src/pipeline/video.ts";

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

  test("buildNvencProbeArgs builds the one-frame lavfi null encode", () => {
    expect(buildNvencProbeArgs("h264_nvenc")).toEqual([
      "-v", "error", "-f", "lavfi", "-i", "color=size=256x256:rate=1",
      "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-",
    ]);
    // Ordinal 0 is a real GPU index, not "unset", so it must still be emitted.
    expect(buildNvencProbeArgs("av1_nvenc", 0)).toContain("-gpu");
    const pinned = buildNvencProbeArgs("hevc_nvenc", 1);
    expect(pinned.slice(pinned.indexOf("-gpu"), pinned.indexOf("-gpu") + 2)).toEqual(["-gpu", "1"]);
  });

  test("nvencGpuArgs is the one place -gpu comes from, and ordinal 0 is a real device", () => {
    expect(nvencGpuArgs(undefined)).toEqual([]);
    expect(nvencGpuArgs(0)).toEqual(["-gpu", "0"]);
    expect(nvencGpuArgs(3)).toEqual(["-gpu", "3"]);
  });

  test("encoderArgs pins every NVENC encoder to the job's CUDA device and leaves CPU codecs alone", () => {
    for (const codec of ["h264_nvenc", "hevc_nvenc", "av1_nvenc"] as const) {
      const args = encoderArgs({ codec, quality: 20, container: "mp4", copyAudio: false }, 1);
      expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 4)).toEqual(["-c:v", codec, "-gpu", "1"]);
    }
    for (const codec of ["h264", "hevc", "av1"] as const) {
      expect(encoderArgs({ codec, quality: 20, container: "mp4", copyAudio: false }, 1)).not.toContain("-gpu");
    }
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
