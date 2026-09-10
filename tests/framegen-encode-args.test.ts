/**
 * The frame-generation encode argv, locked down. ffmpeg options are positional,
 * so an option that drifts across an `-i` silently attaches to the wrong file:
 * these cases assert the exact order, not just that the flags are present.
 */
import { describe, expect, test } from "bun:test";
import { buildFrameGenEncodeArgs } from "../src/pipeline/framegen-encode-sink.ts";
import { rational } from "../src/pipeline/rational.ts";

const base = {
  ffmpeg: "ffmpeg.exe",
  input: "in.mp4",
  output: "out.mp4",
  width: 1280,
  height: 720,
  targetRate: rational(60),
  quality: 20,
};

describe("buildFrameGenEncodeArgs", () => {
  test("the NVENC path muxes a copy of the elementary stream", () => {
    const open = buildFrameGenEncodeArgs({ ...base, codec: "h264_nvenc", hasAudio: false });
    expect(open.nvencArgs).toEqual([
      "-v", "error", "-y", "-f", "h264", "-framerate", "60/1", "-i", "pipe:0",
      "-map", "0:v:0", "-c:v", "copy", "-an",
      "-video_track_timescale", "60", "-movflags", "+faststart", "out.mp4",
    ]);
    expect(open.nvenc).toEqual({ width: 1280, height: 720, fpsNum: 60, fpsDen: 1, codec: "h264", cq: 20 });
  });

  test("audio re-opens the source as input 1, before -map and before any output option", () => {
    const open = buildFrameGenEncodeArgs({ ...base, codec: "h264_nvenc", hasAudio: true });
    const secondInput = open.nvencArgs.indexOf("in.mp4");
    expect(open.nvencArgs[secondInput - 1]).toBe("-i");
    // -c:v copy is an OUTPUT option: before the second -i it would bind to that input.
    expect(secondInput).toBeLessThan(open.nvencArgs.indexOf("-c:v"));
    expect(open.nvencArgs.slice(secondInput + 1, secondInput + 3)).toEqual(["-map", "0:v:0"]);
    expect(open.nvencArgs).toContain("aac");
  });

  test("a CPU codec has no NVENC path and encodes the rawvideo pipe itself", () => {
    const open = buildFrameGenEncodeArgs({ ...base, codec: "h264", hasAudio: false });
    expect(open.nvencArgs).toEqual([]);
    expect(open.nvenc).toBeNull();
    expect(open.rawArgs).toEqual([
      "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1280x720",
      "-framerate", "60/1", "-i", "pipe:0", "-map", "0:v:0", "-an",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "60", "-movflags", "+faststart", "out.mp4",
    ]);
  });

  test("av1_nvenc has no in-process encoder, so it takes the rawvideo path", () => {
    const open = buildFrameGenEncodeArgs({ ...base, codec: "av1_nvenc", hasAudio: false });
    expect(open.nvenc).toBeNull();
    expect(open.rawArgs).toContain("av1_nvenc");
  });

  test("odd NVENC dimensions fall back to the rawvideo path", () => {
    const open = buildFrameGenEncodeArgs({ ...base, width: 641, height: 361, codec: "h264_nvenc", hasAudio: false });
    expect(open.nvenc).toBeNull();
    expect(open.rawArgs).toContain("641x361");
  });

  test("the track timescale is the rate numerator, so one frame is a whole number of ticks", () => {
    const open = buildFrameGenEncodeArgs({ ...base, codec: "h264_nvenc", targetRate: rational(60000, 1001), hasAudio: false });
    const at = open.nvencArgs.indexOf("-video_track_timescale");
    expect(open.nvencArgs[at + 1]).toBe("60000");
    expect(open.nvencArgs).toContain("60000/1001");
  });
});
