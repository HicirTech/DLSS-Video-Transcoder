import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../src/paths.ts";
import { BUNDLED_FFMPEG_DIR, findTool, requireFfmpegTools } from "../src/pipeline/tools.ts";
import { FFMPEG_SUPPLY_HINT } from "../src/server/api-types.ts";

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

test("the hint shared with the web banner names every way the tools are found, and its folder is the bundled one", () => {
  for (const way of ["FFMPEG_PATH", "FFPROBE_PATH", "PATH", "runtime/ffmpeg/bin", "winget install Gyan.FFmpeg"]) expect(FFMPEG_SUPPLY_HINT).toContain(way);
  expect(resolve(PROJECT_ROOT, "runtime/ffmpeg/bin")).toBe(BUNDLED_FFMPEG_DIR);
});
