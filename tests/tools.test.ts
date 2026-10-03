import { afterEach, expect, test } from "bun:test";
import { findTool, requireFfmpegTools } from "../src/pipeline/tools.ts";

const saved = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };

afterEach(() => {
  for (const [name, value] of [["FFMPEG_PATH", saved.ffmpeg], ["FFPROBE_PATH", saved.ffprobe]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("FFMPEG_PATH and FFPROBE_PATH pin the tools, and requireFfmpegTools hands both back", () => {
  // Any existing file stands in: findTool only checks that the pinned path exists.
  process.env.FFMPEG_PATH = process.execPath;
  process.env.FFPROBE_PATH = process.execPath;
  expect(findTool("ffmpeg")).toBe(process.execPath);
  expect(requireFfmpegTools("video jobs")).toEqual({ ffmpeg: process.execPath, ffprobe: process.execPath });
});
