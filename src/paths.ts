/**
 * Canonical filesystem locations: the runtime folder holding the DLSS DLLs, plus the
 * logs, NGX app-data and output folders. NR_RUNTIME_DIR points the runtime elsewhere.
 */
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

/** Project root: the folder that holds package.json. */
export const PROJECT_ROOT = resolve(dirname(import.meta.dir));
export const RUNTIME_DIR = process.env.NR_RUNTIME_DIR ? resolve(process.env.NR_RUNTIME_DIR) : resolve(PROJECT_ROOT, "runtime");
export const CALLER_DIR = resolve(RUNTIME_DIR, "caller");
export const LOGS_DIR = resolve(PROJECT_ROOT, "logs");
export const OUTPUTS_DIR = resolve(PROJECT_ROOT, "outputs");
export const NGX_DATA_DIR = resolve(LOGS_DIR, "ngx");

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export const RUNTIME_FILES = [
  { name: "nvngx_dlssnr.dll", role: "DLSS 5 Neural Rendering runtime (feature 18)" },
  { name: "nvngx_dlss.dll", role: "DLSS Super Resolution runtime (optional upscale stage)" },
  { name: "nvngx_dlssg.dll", role: "DLSS Frame Generation runtime (optional)" },
] as const;
