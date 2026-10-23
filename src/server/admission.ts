/**
 * The host-dependent checks a validated job request passes before it is queued: its input is an existing file, its
 * output stays inside the folders a job may write, and every DLL folder it names is one the server advertises. They
 * need node:fs and node:path, so they live apart from validate.ts, which the web bundles.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { RuntimeManifest } from "../ngx/runtime-catalog.ts";
import { inputAsOutputProblem } from "../pipeline/output-path.ts";
import { type JobRequest, STEP_FIELDS, STEP_KINDS, type StepKind } from "./api-types.ts";
import { checkDllDir } from "./dll-dir.ts";
import { isWithin } from "./path-scope.ts";

/** Whether `path` is absolute and names an existing file, not a folder. */
export function isExistingFile(path: string): boolean {
  return isAbsolute(path) && existsSync(path) && statSync(path).isFile();
}

/** The version folder each step of `request` names, with the step, for the catalog check. */
function stepDllDirs(request: JobRequest): Array<[StepKind, string]> {
  return STEP_KINDS.flatMap((step): Array<[StepKind, string]> => {
    const dllDir = request[STEP_FIELDS[step]]?.dllDir;
    return dllDir === undefined ? [] : [[step, dllDir]];
  });
}

/** What admission needs from the host. */
export interface AdmissionScope {
  /** The app-data folder, one of the two places an output may go. */
  appDataDir: string;
  /** GET /api/catalog's answer; built only when a step names a dllDir. */
  loadCatalog: () => RuntimeManifest;
}

/** Why `request` cannot be queued on this host, or null when it can. */
export function checkJobAdmission(request: JobRequest, scope: AdmissionScope): string | null {
  if (!isExistingFile(request.input)) return `Input file not found: ${request.input}. Provide an absolute path to a file that exists.`;
  // Confine the output path so a request cannot write anywhere on the host. The runtime folder is not a root, so a
  // job cannot overwrite the DLLs every job loads.
  if (request.output !== undefined) {
    const inputDir = dirname(resolve(request.input));
    if (!isAbsolute(request.output) || ![scope.appDataDir, inputDir].some((root) => isWithin(request.output!, root))) {
      return `The output path must be absolute and inside the app-data folder (${scope.appDataDir}) or the input's own folder (${inputDir}), or a folder below either; omit output to write next to the input.`;
    }
    const inputProblem = inputAsOutputProblem(request.input, request.output);
    if (inputProblem) return inputProblem;
  }
  // A DLL directory drives a native LoadLibrary, so it must be one the server itself advertises through
  // GET /api/catalog, for the feature of the step that loads it.
  const dllDirs = stepDllDirs(request);
  if (dllDirs.length === 0) return null;
  const catalog = scope.loadCatalog();
  for (const [step, dllDir] of dllDirs) {
    const dllDirError = checkDllDir(dllDir, step, catalog);
    if (dllDirError) return dllDirError;
  }
  return null;
}
