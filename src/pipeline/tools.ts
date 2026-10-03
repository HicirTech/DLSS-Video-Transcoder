/**
 * External tool discovery: ffmpeg / ffprobe are optional and only needed for
 * video. They are looked up on PATH and in a few conventional folders.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_DIR } from "../paths.ts";
import type { ToolsReport } from "../server/api-types.ts";

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
 * Locate a tool, in order: the `<NAME>_PATH` environment variable (FFMPEG_PATH,
 * FFPROBE_PATH — the documented override, and the only way to pin a specific
 * build), then PATH, then EXTRA_DIRS. Null when none of them has it.
 */
export function findTool(name: string): string | null {
  const env = process.env[`${name.toUpperCase()}_PATH`];
  if (env && existsSync(env)) return env;
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const dir of EXTRA_DIRS) {
    const candidate = join(dir, `${name}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** ffmpeg and ffprobe, or an error that names the job type that needs them and how to supply them. */
export function requireFfmpegTools(purpose: string): { ffmpeg: string; ffprobe: string } {
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  if (!ffmpeg || !ffprobe) {
    throw new Error(`ffmpeg and ffprobe are required for ${purpose} (install with \`winget install Gyan.FFmpeg\` or set FFMPEG_PATH / FFPROBE_PATH).`);
  }
  return { ffmpeg, ffprobe };
}

function versionOf(path: string | null): string | null {
  if (!path) return null;
  try {
    const proc = Bun.spawnSync([path, "-version"], { stdout: "pipe", stderr: "pipe" });
    const first = new TextDecoder().decode(proc.stdout).split(/\r?\n/)[0] ?? "";
    const match = /version\s+(\S+)/.exec(first);
    return match ? match[1]! : first.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether this ffmpeg build was compiled with NVENC — not whether NVENC will
 * run: only encode-select.ts's one-frame probe proves that. Null means no
 * ffmpeg to ask, which is a different report than a build without NVENC.
 */
function hasNvenc(ffmpeg: string | null): boolean | null {
  if (!ffmpeg) return null;
  try {
    const proc = Bun.spawnSync([ffmpeg, "-hide_banner", "-encoders"], { stdout: "pipe", stderr: "pipe" });
    return new TextDecoder().decode(proc.stdout).includes("h264_nvenc");
  } catch {
    return null;
  }
}

export function toolsReport(): ToolsReport {
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  return {
    ffmpeg: { path: ffmpeg, version: versionOf(ffmpeg) },
    ffprobe: { path: ffprobe, version: versionOf(ffprobe) },
    nvenc: hasNvenc(ffmpeg),
  };
}
