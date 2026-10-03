/**
 * The catalog half of validating a job's dllDir: the folder must be a version folder of the DLSS
 * feature the job loads. It needs the catalog and path resolution, so it sits beside main.ts and
 * not in validate.ts, which the web mock backend shares and which therefore imports no Node module.
 */
import { isAbsolute, resolve } from "node:path";
import { featureByKey, type FeatureManifest, type RuntimeManifest } from "../ngx/runtime-catalog.ts";
import type { EngineKind } from "./api-types.ts";

/**
 * Why a job of `engine` cannot load `dllDir`, or null when it can: the folder has to be one of the
 * versions that `catalog` (GET /api/catalog) lists for the engine's own feature. A folder of another
 * feature is refused by name: left to the job, an nr job fails on the missing nvngx_dlssnr.dll only
 * after it has queued and opened its GPU session, and what NGX does with an sr job's wrong folder
 * has not been measured.
 */
export function checkDllDir(dllDir: string, engine: Exclude<EngineKind, "bypass">, catalog: RuntimeManifest): string | null {
  const wanted = featureByKey(engine);
  const folder = isAbsolute(dllDir) ? resolve(dllDir) : null;
  const listsFolder = (feature: FeatureManifest): boolean => feature.versions.some((version) => resolve(version.dir) === folder);
  if (folder !== null) {
    if (catalog.features.some((feature) => feature.id === wanted.id && listsFolder(feature))) return null;
    const holder = catalog.features.find(listsFolder);
    if (holder) return `dllDir ${dllDir} holds ${holder.name} (${holder.dllName}); an ${engine} job needs a ${wanted.name} folder (${wanted.dllName}) from GET /api/catalog.`;
  }
  return `dllDir must be the absolute "dir" of one of the ${wanted.name} versions (${wanted.dllName}) that GET /api/catalog lists; omit it to load the bundled runtime DLL.`;
}
