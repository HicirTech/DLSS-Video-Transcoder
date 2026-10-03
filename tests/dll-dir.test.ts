/**
 * checkDllDir (src/server/dll-dir.ts): a job's dllDir has to be a version folder of the DLSS
 * feature the job loads. A synthetic catalog fixes every case; one case builds the catalog from a
 * temporary runtime tree, to hold the check to what GET /api/catalog really lists.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { FEATURES, type FeatureDescriptor, type FeatureKey, type RuntimeManifest, buildRuntimeCatalog, featureByKey } from "../src/ngx/runtime-catalog.ts";
import { checkDllDir } from "../src/server/dll-dir.ts";

const RUNTIME = resolve(sep === "\\" ? "C:\\app\\runtime" : "/app/runtime");

/** The folder the synthetic catalog lists for a feature: one version folder under its runtime subfolder. */
function listedDir(key: FeatureKey): string {
  return join(RUNTIME, featureByKey(key).runtimeSubdir, "310.7.0.0");
}

function manifestEntry(feature: FeatureDescriptor, dirs: string[]): RuntimeManifest["features"][number] {
  const versions = dirs.map((dir) => ({ version: "310.7.0.0", path: join(dir, feature.dllName), sizeMB: 1, dir, source: "runtime" as const, sortKey: "0" }));
  return { id: feature.id, name: feature.name, dllName: feature.dllName, versions };
}

/** All four features, each listing its own version folder, as buildRuntimeCatalog reports them. */
const CATALOG: RuntimeManifest = { features: FEATURES.map((feature) => manifestEntry(feature, [listedDir(feature.key)])) };

describe("checkDllDir", () => {
  test("accepts the version folders of the job's own feature", () => {
    expect(checkDllDir(listedDir("sr"), "sr", CATALOG)).toBeNull();
    expect(checkDllDir(listedDir("nr"), "nr", CATALOG)).toBeNull();
  });

  test("accepts any spelling of that folder", () => {
    expect(checkDllDir(join(RUNTIME, "dlss", "other", "..", "310.7.0.0"), "sr", CATALOG)).toBeNull();
    expect(checkDllDir(`${listedDir("nr")}${sep}`, "nr", CATALOG)).toBeNull();
  });

  test("refuses a folder of another feature and names what it holds and what the job needs", () => {
    expect(checkDllDir(listedDir("fg"), "sr", CATALOG)).toBe(
      `dllDir ${listedDir("fg")} holds DLSS Frame Generation (nvngx_dlssg.dll); an sr job needs a DLSS Super Resolution folder (nvngx_dlss.dll) from GET /api/catalog.`,
    );
    expect(checkDllDir(listedDir("rr"), "nr", CATALOG)).toBe(
      `dllDir ${listedDir("rr")} holds DLSS Ray Reconstruction (nvngx_dlssd.dll); an nr job needs a DLSS Neural Rendering folder (nvngx_dlssnr.dll) from GET /api/catalog.`,
    );
  });

  test("an sr job is refused every other feature's folder, and so is an nr job", () => {
    const others = (key: FeatureKey): FeatureKey[] => FEATURES.map((feature) => feature.key).filter((other) => other !== key);
    for (const engine of ["sr", "nr"] as const) {
      for (const other of others(engine)) {
        expect(checkDllDir(listedDir(other), engine, CATALOG), `${engine} job, ${other} folder`).toContain(`holds ${featureByKey(other).name}`);
      }
    }
  });

  test("a folder that two features list belongs to either job", () => {
    const shared = join(RUNTIME, "both");
    const catalog: RuntimeManifest = { features: FEATURES.map((feature) => manifestEntry(feature, feature.key === "sr" || feature.key === "nr" ? [shared] : [listedDir(feature.key)])) };
    expect(checkDllDir(shared, "sr", catalog)).toBeNull();
    expect(checkDllDir(shared, "nr", catalog)).toBeNull();
  });

  test("a folder no feature lists, or a relative one, is refused with the way out", () => {
    const expected = `dllDir must be the absolute "dir" of one of the DLSS Super Resolution versions (nvngx_dlss.dll) that GET /api/catalog lists; omit it to load the bundled runtime DLL.`;
    expect(checkDllDir(join(RUNTIME, "dlss", "999.0.0.0"), "sr", CATALOG)).toBe(expected);
    expect(checkDllDir(join("dlss", "310.7.0.0"), "sr", CATALOG)).toBe(expected);
    expect(checkDllDir(join(RUNTIME, "dlssnr", "999.0.0.0"), "nr", CATALOG)).toContain("DLSS Neural Rendering versions (nvngx_dlssnr.dll)");
  });
});

describe("checkDllDir against the catalog of a runtime tree", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("each installed feature's folder belongs to that feature's jobs alone", () => {
    const root = mkdtempSync(join(tmpdir(), "dll-dir-"));
    dirs.push(root);
    const runtime = join(root, "runtime");
    for (const feature of FEATURES) {
      mkdirSync(join(runtime, feature.runtimeSubdir), { recursive: true });
      writeFileSync(join(runtime, feature.runtimeSubdir, feature.dllName), "not a real DLL");
    }
    // An empty DLSS Swapper cache, so the machine's own installs do not join the catalog.
    const catalog = buildRuntimeCatalog(runtime, join(root, "no-swapper-cache"));
    for (const engine of ["sr", "nr"] as const) {
      for (const feature of FEATURES) {
        const message = checkDllDir(join(runtime, feature.runtimeSubdir), engine, catalog);
        if (feature.key === engine) expect(message, `${engine} job, own folder`).toBeNull();
        else expect(message, `${engine} job, ${feature.key} folder`).toContain(`holds ${feature.name} (${feature.dllName})`);
      }
    }
  });
});
