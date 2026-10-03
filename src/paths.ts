/**
 * Canonical filesystem locations: the runtime folder holding the DLSS DLLs (NR_RUNTIME_DIR
 * points it elsewhere), the folder of the generated nvngx.dll caller shim, and the NGX app-data folder.
 */
import { dirname, resolve } from "node:path";

/** Project root: the folder that holds package.json. */
const PROJECT_ROOT = resolve(dirname(import.meta.dir));
export const RUNTIME_DIR = process.env.NR_RUNTIME_DIR ? resolve(process.env.NR_RUNTIME_DIR) : resolve(PROJECT_ROOT, "runtime");
export const CALLER_DIR = resolve(RUNTIME_DIR, "caller");
const LOGS_DIR = resolve(PROJECT_ROOT, "logs");
export const NGX_DATA_DIR = resolve(LOGS_DIR, "ngx");
