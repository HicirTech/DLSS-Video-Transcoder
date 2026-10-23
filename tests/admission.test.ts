/**
 * What a validated job request must pass on this host before it queues (src/server/admission.ts): an input that is
 * an existing file, an output inside the app-data folder or the input's own, and DLL folders the catalog lists for
 * each step's feature. Temporary files and a synthetic catalog; no GPU.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURES, type FeatureDescriptor, type FeatureKey, type RuntimeManifest, featureByKey } from "../src/ngx/runtime-catalog.ts";
import { checkJobAdmission } from "../src/server/admission.ts";
import type { JobRequest } from "../src/server/api-types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A host with an app-data folder, an input folder holding in.mp4 and a sibling folder, and one version folder per feature. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "admission-"));
  dirs.push(root);
  const appDataDir = join(root, "app-data");
  const inputDir = join(root, "videos");
  const siblingDir = join(root, "elsewhere");
  for (const dir of [appDataDir, inputDir, siblingDir]) mkdirSync(dir);
  const input = join(inputDir, "in.mp4");
  writeFileSync(input, "video");
  const versionDir = (key: FeatureKey): string => join(root, "runtime", featureByKey(key).runtimeSubdir, "310.7.0.0");
  const entry = (feature: FeatureDescriptor): RuntimeManifest["features"][number] => ({
    key: feature.key,
    id: feature.id,
    name: feature.name,
    dllName: feature.dllName,
    versions: [{ version: "310.7.0.0", path: join(versionDir(feature.key), feature.dllName), sizeMB: 1, dir: versionDir(feature.key), source: "runtime", sortKey: "0" }],
  });
  const catalog: RuntimeManifest = { features: FEATURES.map(entry) };
  let catalogLoads = 0;
  const scope = { appDataDir, loadCatalog: () => { catalogLoads++; return catalog; } };
  return { root, appDataDir, inputDir, siblingDir, input, versionDir, scope, catalogLoads: () => catalogLoads };
}

const video = (input: string, more: Partial<JobRequest> = {}): JobRequest => ({ kind: "video", input, ...more });

describe("checkJobAdmission", () => {
  test("an output in the input's folder, below it, or in the app-data folder is accepted", () => {
    const h = host();
    for (const output of [join(h.inputDir, "out.mp4"), join(h.inputDir, "renders", "out.mp4"), join(h.appDataDir, "out.mp4")]) {
      expect(checkJobAdmission(video(h.input, { output }), h.scope), output).toBeNull();
    }
  });

  test("a relative output, or one outside both folders, is refused with the two folders it may go in", () => {
    const h = host();
    const refusal = `The output path must be absolute and inside the app-data folder (${h.appDataDir}) or the input's own folder (${h.inputDir}), or a folder below either; omit output to write next to the input.`;
    expect(checkJobAdmission(video(h.input, { output: "out.mp4" }), h.scope)).toBe(refusal);
    expect(checkJobAdmission(video(h.input, { output: join(h.siblingDir, "out.mp4") }), h.scope)).toBe(refusal);
    expect(checkJobAdmission(video(h.input, { output: join(h.root, "runtime", "out.mp4") }), h.scope)).toBe(refusal);
  });

  test("a missing, relative or folder input is refused", () => {
    const h = host();
    for (const input of [join(h.inputDir, "missing.mp4"), "in.mp4", h.inputDir]) {
      expect(checkJobAdmission(video(input), h.scope), input).toBe(`Input file not found: ${input}. Provide an absolute path to a file that exists.`);
    }
  });

  test("the output may not be the input itself", () => {
    const h = host();
    expect(checkJobAdmission(video(h.input, { output: h.input }), h.scope)).toStartWith(`The output path ${h.input} is the input file itself`);
  });

  test("each step's dllDir has to be one of its own feature's listed folders", () => {
    const h = host();
    const steps = {
      sr: (dllDir: string): Partial<JobRequest> => ({ superResolution: { scale: { mode: "factor", factor: 1.5, width: 1920, height: 1080 }, dllDir } }),
      nr: (dllDir: string): Partial<JobRequest> => ({ neuralRendering: { settings: { preset: 0, style: 0, intensity: 1, localTone: 1, localStructure: 1, skinStructure: 0, autoMask: true, uiCorrection: false }, dllDir } }),
      fg: (dllDir: string): Partial<JobRequest> => ({ frameGen: { targetFps: "60", dllDir } }),
    };
    for (const key of ["sr", "nr", "fg"] as const) {
      expect(checkJobAdmission(video(h.input, steps[key](h.versionDir(key))), h.scope), key).toBeNull();
      const other = key === "sr" ? "fg" : "sr";
      expect(checkJobAdmission(video(h.input, steps[key](h.versionDir(other))), h.scope), key).toContain(`holds ${featureByKey(other).name}`);
      expect(checkJobAdmission(video(h.input, steps[key](join(h.root, "nowhere"))), h.scope), key).toContain("that GET /api/catalog lists");
    }
  });

  test("the catalog is only built when a step names a dllDir", () => {
    const h = host();
    expect(checkJobAdmission(video(h.input, { frameGen: { targetFps: "60" } }), h.scope)).toBeNull();
    expect(h.catalogLoads()).toBe(0);
    expect(checkJobAdmission(video(h.input, { frameGen: { targetFps: "60", dllDir: h.versionDir("fg") } }), h.scope)).toBeNull();
    expect(h.catalogLoads()).toBe(1);
  });
});
