/**
 * External tool discovery: ffmpeg / ffprobe are optional and only needed for video. They come from FFMPEG_PATH /
 * FFPROBE_PATH when set, otherwise from PATH and a few conventional folders.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_DIR } from "../paths.ts";
import { FFMPEG_SUPPLY_HINT, type ToolsReport } from "../server/api-types.ts";
import { runBounded } from "./video-probe.ts";

/** Where a build placed under the project's runtime folder is found; it stays there when NR_RUNTIME_DIR moves the DLLs. */
export const BUNDLED_FFMPEG_DIR = join(DEFAULT_RUNTIME_DIR, "ffmpeg", "bin");

/** Searched after PATH, because the common Windows installers do not always extend it. */
const EXTRA_DIRS = [
  BUNDLED_FFMPEG_DIR,
  join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links"),
  "C:\\ffmpeg\\bin",
  "C:\\Program Files\\ffmpeg\\bin",
  join(process.env.USERPROFILE ?? "", "scoop", "shims"),
  "C:\\ProgramData\\chocolatey\\bin",
];

/**
 * Locate a tool: the `<NAME>_PATH` environment variable (FFMPEG_PATH, FFPROBE_PATH — the documented override, and
 * the only way to pin a specific build) when it is set, which is an error when nothing is there rather than skipped;
 * otherwise PATH, then EXTRA_DIRS. Null when the variable is unset and none of those has it.
 */
export function findTool(name: string): string | null {
  const variable = `${name.toUpperCase()}_PATH`;
  const pinned = process.env[variable];
  if (pinned) {
    if (existsSync(pinned)) return pinned;
    throw new Error(`${variable}=${pinned} does not exist; point it at your ${name}.exe or unset it to search PATH and the runtime/ffmpeg/bin folder.`);
  }
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const dir of EXTRA_DIRS) {
    const candidate = join(dir, `${name}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** ffmpeg and ffprobe, or an error that names the missing one, the job type that needs them and how to supply them. */
export function requireFfmpegTools(purpose: string): { ffmpeg: string; ffprobe: string } {
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  if (!ffmpeg || !ffprobe) {
    const missing = [...(ffmpeg ? [] : ["ffmpeg"]), ...(ffprobe ? [] : ["ffprobe"])];
    throw new Error(`${missing.join(" and ")} ${missing.length === 1 ? "was" : "were"} not found; ffmpeg and ffprobe are required for ${purpose}: ${FFMPEG_SUPPLY_HINT}.`);
  }
  return { ffmpeg, ffprobe };
}

/** The version a tool prints first, or null when it cannot be run, fails, or does not finish in time. */
async function versionOf(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const run = await runBounded([path, "-version"]);
    if (run.exitCode !== 0) return null;
    const first = run.stdout.split(/\r?\n/)[0] ?? "";
    const match = /version\s+(\S+)/.exec(first);
    return match ? match[1]! : first.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether this ffmpeg build was compiled with NVENC — not whether NVENC will
 * run: only encode-select.ts's one-frame probe proves that. Null means no
 * ffmpeg to ask, or one that failed or did not answer in time, which is a
 * different report than a build without NVENC.
 */
async function hasNvenc(ffmpeg: string | null): Promise<boolean | null> {
  if (!ffmpeg) return null;
  try {
    const run = await runBounded([ffmpeg, "-hide_banner", "-encoders"]);
    return run.exitCode === 0 ? run.stdout.includes("h264_nvenc") : null;
  } catch {
    return null;
  }
}

/** GET /api/tools: where ffmpeg and ffprobe are and what they report, asked without blocking the server thread. */
export async function toolsReport(): Promise<ToolsReport> {
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  const [ffmpegVersion, ffprobeVersion, nvenc] = await Promise.all([versionOf(ffmpeg), versionOf(ffprobe), hasNvenc(ffmpeg)]);
  return {
    ffmpeg: { path: ffmpeg, version: ffmpegVersion },
    ffprobe: { path: ffprobe, version: ffprobeVersion },
    nvenc,
  };
}
