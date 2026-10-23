/**
 * The catalog half of validating a step's dllDir: the folder must be a version folder of the DLSS
 * feature the step loads. It needs the catalog and path resolution, so it sits beside admission.ts
 * and not in validate.ts, which the web mock backend shares and which therefore imports no Node module.
 */
import { isAbsolute, resolve } from "node:path";
import { featureByKey, type FeatureManifest, type RuntimeManifest } from "../ngx/runtime-catalog.ts";
import { STEP_FIELDS, type StepKind } from "./api-types.ts";

/**
 * Why `step` cannot load `dllDir`, or null when it can: the folder has to be one of the versions that
 * `catalog` (GET /api/catalog) lists for the step's feature. A folder of another feature is refused by
 * name: left to the job, an NR step fails on the missing nvngx_dlssnr.dll only after the job has queued
 * and opened its GPU session, and what NGX does with an SR step's wrong folder has not been measured.
 */
export function checkDllDir(dllDir: string, step: StepKind, catalog: RuntimeManifest): string | null {
  const wanted = featureByKey(step);
  const field = `${STEP_FIELDS[step]}.dllDir`;
  const folder = isAbsolute(dllDir) ? resolve(dllDir) : null;
  const listsFolder = (listed: FeatureManifest): boolean => listed.versions.some((version) => resolve(version.dir) === folder);
  if (folder !== null) {
    if (catalog.features.some((listed) => listed.id === wanted.id && listsFolder(listed))) return null;
    const holder = catalog.features.find(listsFolder);
    if (holder) return `${field} ${dllDir} holds ${holder.name} (${holder.dllName}); this step needs a ${wanted.name} folder (${wanted.dllName}) from GET /api/catalog.`;
  }
  return `${field} must be the absolute "dir" of one of the ${wanted.name} versions (${wanted.dllName}) that GET /api/catalog lists; omit it to load the bundled runtime DLL.`;
}
