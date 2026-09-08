/**
 * External tool discovery: ffmpeg / ffprobe are optional and only needed for
 * video. They are looked up on PATH and in a few conventional folders.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolsReport } from "../server/api-types.ts";

const EXTRA_DIRS = [
  join(import.meta.dir, "..", "..", "runtime", "ffmpeg", "bin"), // ffmpeg bundled under the project runtime
  join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links"),
  "C:\\ffmpeg\\bin",
  "C:\\Program Files\\ffmpeg\\bin",
  join(process.env.USERPROFILE ?? "", "scoop", "shims"),
  "C:\\ProgramData\\chocolatey\\bin",
];

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
