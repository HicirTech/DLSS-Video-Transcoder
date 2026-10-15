/**
 * The catalog half of validating a job's dllDir: the folder must be a version folder of the DLSS
 * feature the job loads. It needs the catalog and path resolution, so it sits beside main.ts and
 * not in validate.ts, which the web mock backend shares and which therefore imports no Node module.
 */
import { isAbsolute, resolve } from "node:path";
import { featureByKey, type FeatureManifest, type RuntimeManifest } from "../ngx/runtime-catalog.ts";
import type { JobRequest } from "./api-types.ts";

/** The DLSS feature a job loads a DLL of, the one its dllDir has to be a version of. */
type DllFeature = "sr" | "nr" | "fg";

/** The feature of the DLL `request` loads, or null for a bypass job without frame generation, which loads none. */
export function dllFeatureOf(request: Pick<JobRequest, "engine" | "frameGen">): DllFeature | null {
  if (request.frameGen !== undefined) return "fg";
  return request.engine === "bypass" ? null : request.engine;
}

/** How a refusal names the job: by its engine, or as frame generation, which ignores the engine. */
const JOB_NAME: Record<DllFeature, string> = { sr: "an sr job", nr: "an nr job", fg: "a frame generation job" };

/**
 * Why a job that loads `feature` cannot load `dllDir`, or null when it can: the folder has to be one
 * of the versions that `catalog` (GET /api/catalog) lists for that feature. A folder of another
 * feature is refused by name: left to the job, an nr job fails on the missing nvngx_dlssnr.dll only
 * after it has queued and opened its GPU session, and what NGX does with an sr job's wrong folder
 * has not been measured.
 */
export function checkDllDir(dllDir: string, feature: DllFeature, catalog: RuntimeManifest): string | null {
  const wanted = featureByKey(feature);
  const folder = isAbsolute(dllDir) ? resolve(dllDir) : null;
  const listsFolder = (listed: FeatureManifest): boolean => listed.versions.some((version) => resolve(version.dir) === folder);
  if (folder !== null) {
    if (catalog.features.some((listed) => listed.id === wanted.id && listsFolder(listed))) return null;
    const holder = catalog.features.find(listsFolder);
    if (holder) return `dllDir ${dllDir} holds ${holder.name} (${holder.dllName}); ${JOB_NAME[feature]} needs a ${wanted.name} folder (${wanted.dllName}) from GET /api/catalog.`;
  }
  return `dllDir must be the absolute "dir" of one of the ${wanted.name} versions (${wanted.dllName}) that GET /api/catalog lists; omit it to load the bundled runtime DLL.`;
}
