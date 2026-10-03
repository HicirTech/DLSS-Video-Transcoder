/**
 * Which runtime DLLs the probe report lists, whether each is installed and what the installed copy
 * is. Filesystem work only — no GPU, no native load — so the server answers GET /api/runtime from
 * here without starting a probe, and a temporary runtime/ tree can test it.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parsePe } from "../native/pe.ts";
import { parseVersionInfo } from "../native/version-info.ts";
import type { ProbeReport, RuntimeFile } from "../server/api-types.ts";
import { featureByKey, runtimeDllCandidates, type FeatureDescriptor } from "./runtime-catalog.ts";

// Only the report's wording lives here. Which file each feature needs, and where
// it may sit under runtime/, is runtime-catalog.ts's rule — so the report and
// the version list cannot disagree about what is installed.
const RUNTIME_FILES: { feature: FeatureDescriptor; role: string }[] = [
  { feature: featureByKey("nr"), role: "DLSS 5 Neural Rendering (feature 18)" },
  { feature: featureByKey("sr"), role: "DLSS Super Resolution (feature 1)" },
  { feature: featureByKey("fg"), role: "DLSS Frame Generation (feature 11)" },
];

async function inventoryRuntimeFiles(runtimeDir: string): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = [];
  for (const { feature, role } of RUNTIME_FILES) {
    const name = feature.dllName;
    // The first candidate is the flat copy when there is one — the file a job
    // with no dllDir loads — and otherwise the first version folder holding it.
    const found = runtimeDllCandidates(runtimeDir, feature)[0] ?? null;
    if (!found) {
      files.push({ name, role, present: false, path: null, sizeMB: null, version: null, exports: null });
      continue;
    }
    let version: string | null = null;
    let exports: string[] | null = null;
    try {
      // One read serves both fields: nvngx_dlssnr.dll is 158 MB here, so opening
      // it again just for the version would double the probe's I/O. Version
      // first — parseVersionInfo does not throw, parsePe does on a malformed
      // image, and a DLL whose exports cannot be listed still has a version.
      const bytes = new Uint8Array(await Bun.file(found.path).arrayBuffer());
      version = parseVersionInfo(bytes).fileVersion;
      exports = parsePe(bytes).exports.map((e) => e.name);
    } catch {
      // A file that cannot be read still gets a row saying it is there; the
      // fields it could not supply stay null.
    }
    files.push({
      name,
      role,
      present: true,
      path: found.path,
      sizeMB: Math.round((statSync(found.path).size / 1048576) * 10) / 10,
      version,
      exports,
    });
  }
  return files;
}

/** The runtime section of a probe report: the folder and the DLLs it lists. */
export async function runtimeReport(runtimeDir: string): Promise<ProbeReport["runtime"]> {
  const folder = resolve(runtimeDir);
  return { folder, files: await inventoryRuntimeFiles(folder) };
}
