/**
 * Canonical filesystem locations: the runtime folder holding the DLSS DLLs (NR_RUNTIME_DIR
 * points the server elsewhere), the folders beneath it for the generated nvngx.dll caller shim
 * and for each feature's DLLs, and the NGX app-data folder (NR_APPDATA).
 */
import { dirname, join, resolve } from "node:path";
import { type FeatureKey, featureByKey } from "./ngx/runtime-catalog.ts";

/** Project root: the folder that holds package.json. */
export const PROJECT_ROOT = resolve(dirname(import.meta.dir));
/** <repo>/runtime: where the CLI looks unless --runtime says otherwise, and the server unless NR_RUNTIME_DIR does. */
export const DEFAULT_RUNTIME_DIR = resolve(PROJECT_ROOT, "runtime");
export const RUNTIME_DIR = process.env.NR_RUNTIME_DIR ? resolve(process.env.NR_RUNTIME_DIR) : DEFAULT_RUNTIME_DIR;
const LOGS_DIR = resolve(PROJECT_ROOT, "logs");
/** The folder NGX may write logs and uploads into: NR_APPDATA, else <repo>/logs. */
export const APP_DATA_DIR = process.env.NR_APPDATA ? resolve(process.env.NR_APPDATA) : LOGS_DIR;
export const NGX_DATA_DIR = resolve(LOGS_DIR, "ngx");

/** Where the generated nvngx.dll shim sits for a runtime folder: beside the feature folders, never inside one. */
export function callerDir(runtimeDir: string): string {
  return join(runtimeDir, "caller");
}

/** The folder a feature's DLL is loaded from by default: runtime-catalog.ts's subfolder for it under the runtime folder. */
export function featureDir(runtimeDir: string, feature: FeatureKey): string {
  return join(runtimeDir, featureByKey(feature).runtimeSubdir);
}
