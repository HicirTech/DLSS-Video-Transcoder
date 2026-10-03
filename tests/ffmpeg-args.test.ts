/** The ffmpeg argv the video paths share, pinned as literal arrays so a refactor cannot change a flag unseen. */
import { describe, expect, test } from "bun:test";
import { aspectArgs, audioArgs, decodeArgv, faststartArgs, muxCopyArgs } from "../src/pipeline/ffmpeg-args.ts";
import { rational } from "../src/pipeline/rational.ts";

describe("decodeArgv", () => {
  test("decodes to raw RGBA on pipe:1, with no scale filter at the source size", () => {
    expect(decodeArgv({ input: "in.mp4", source: { width: 1920, height: 1080 }, output: { width: 1920, height: 1080 } })).toEqual([
      "-v", "error", "-nostdin", "-i", "in.mp4", "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
    ]);
  });

  test("adds a lanczos scale when the output size differs in either dimension", () => {
    const scaled = ["-v", "error", "-nostdin", "-i", "in.mp4", "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "-vf", "scale=1280:720:flags=lanczos", "pipe:1"];
    expect(decodeArgv({ input: "in.mp4", source: { width: 1920, height: 1080 }, output: { width: 1280, height: 720 } })).toEqual(scaled);
    expect(decodeArgv({ input: "in.mp4", source: { width: 1280, height: 1080 }, output: { width: 1280, height: 720 } })).toEqual(scaled);
  });
});

describe("audioArgs and faststartArgs", () => {
  test("audio is copied for mkv, re-encoded to AAC for the other containers, and dropped when not carried over", () => {
    expect(audioArgs(true, "mkv")).toEqual(["-map", "1:a:0", "-c:a", "copy"]);
    expect(audioArgs(true, "mp4")).toEqual(["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]);
    expect(audioArgs(true, "mov")).toEqual(["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]);
    for (const container of ["mp4", "mkv", "mov"] as const) expect(audioArgs(false, container)).toEqual(["-an"]);
  });

  test("mp4 and mov are faststart, mkv is left alone", () => {
    expect(faststartArgs("mp4")).toEqual(["-movflags", "+faststart"]);
    expect(faststartArgs("mov")).toEqual(["-movflags", "+faststart"]);
    expect(faststartArgs("mkv")).toEqual([]);
  });
});

describe("aspectArgs", () => {
  test("a square-pixel source adds nothing", () => {
    expect(aspectArgs(null, 1920, 1080, "h264")).toEqual([]);
  });

  test("a stream copy needs the container tag and the bitstream's sample aspect, and a re-encode only the tag", () => {
    expect(aspectArgs(rational(4, 3), 720, 480, "h264")).toEqual(["-aspect", "4:3", "-bsf:v", "h264_metadata=sample_aspect_ratio=8/9"]);
    expect(aspectArgs(rational(4, 3), 720, 480, null)).toEqual(["-aspect", "4:3"]);
  });
});

describe("muxCopyArgs", () => {
  test("muxes the elementary stream on pipe:0 and carries the first audio track across", () => {
    expect(
      muxCopyArgs({ demux: "hevc", frameRate: "30000/1001", audioSource: "in.mp4", container: "mkv", displayAspect: null, size: { width: 1920, height: 1080 }, output: "out.mkv" }),
    ).toEqual([
      "-v", "error", "-y", "-f", "hevc", "-framerate", "30000/1001", "-i", "pipe:0", "-i", "in.mp4",
      "-map", "0:v:0", "-c:v", "copy", "-map", "1:a:0", "-c:a", "copy", "out.mkv",
    ]);
  });

  test("without audio there is no second input, and an mp4 gets faststart before the file name", () => {
    expect(
      muxCopyArgs({ demux: "h264", frameRate: "25", audioSource: null, container: "mp4", displayAspect: null, size: { width: 1280, height: 720 }, output: "out.mp4" }),
    ).toEqual(["-v", "error", "-y", "-f", "h264", "-framerate", "25", "-i", "pipe:0", "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", "out.mp4"]);
  });

  test("a non-square-pixel source restates its aspect on the copied stream, before the audio flags", () => {
    expect(
      muxCopyArgs({ demux: "h264", frameRate: "25", audioSource: "in.mp4", container: "mov", displayAspect: rational(4, 3), size: { width: 720, height: 480 }, output: "out.mov" }),
    ).toEqual([
      "-v", "error", "-y", "-f", "h264", "-framerate", "25", "-i", "pipe:0", "-i", "in.mp4",
      "-map", "0:v:0", "-c:v", "copy", "-aspect", "4:3", "-bsf:v", "h264_metadata=sample_aspect_ratio=8/9",
      "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "out.mov",
    ]);
  });

  test("extra flags sit between the audio flags and the container's own", () => {
    const args = muxCopyArgs({
      demux: "h264", frameRate: "60000/1001", audioSource: null, container: "mp4", displayAspect: null,
      size: { width: 1920, height: 1080 }, extra: ["-video_track_timescale", "60000"], output: "out.mp4",
    });
    expect(args.slice(-5)).toEqual(["-video_track_timescale", "60000", "-movflags", "+faststart", "out.mp4"]);
    expect(args).toContain("-an");
  });
});
