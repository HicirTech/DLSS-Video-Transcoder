/**
 * The runtime section of the probe report (src/ngx/runtime-inventory.ts) over a temporary runtime/
 * tree. It is filesystem work only, which is why GET /api/runtime can answer from it with no probe.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FORWARDER_EXPORTS, buildForwarderDll } from "../src/ngx/forwarder.ts";
import { runtimeReport } from "../src/ngx/runtime-inventory.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeTree(files: Record<string, Uint8Array>): string {
  const runtime = join(mkdtempSync(join(tmpdir(), "runtime-inventory-")), "runtime");
  dirs.push(dirname(runtime));
  mkdirSync(runtime);
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(runtime, dirname(path)), { recursive: true });
    writeFileSync(join(runtime, path), bytes);
  }
  return runtime;
}

describe("runtimeReport", () => {
  test("lists the three runtime DLLs in the report's order, installed or not", async () => {
    const runtime = runtimeTree({});
    const report = await runtimeReport(runtime);
    expect(report.folder).toBe(resolve(runtime));
    expect(report.files.map((file) => [file.name, file.role, file.present])).toEqual([
      ["nvngx_dlssnr.dll", "DLSS 5 Neural Rendering (feature 18)", false],
      ["nvngx_dlss.dll", "DLSS Super Resolution (feature 1)", false],
      ["nvngx_dlssg.dll", "DLSS Frame Generation (feature 11)", false],
    ]);
    for (const file of report.files) expect(file, file.name).toMatchObject({ path: null, sizeMB: null, version: null, exports: null });
  });

  test("an installed DLL is listed with its path and, read as a PE image, its exports", async () => {
    const shim = buildForwarderDll().bytes;
    const runtime = runtimeTree({ "dlssnr/nvngx_dlssnr.dll": shim });
    const [installed, ...missing] = (await runtimeReport(runtime)).files;
    expect(installed).toEqual({
      name: "nvngx_dlssnr.dll",
      role: "DLSS 5 Neural Rendering (feature 18)",
      present: true,
      path: join(runtime, "dlssnr", "nvngx_dlssnr.dll"),
      sizeMB: 0,
      version: null,
      exports: [...FORWARDER_EXPORTS].sort(),
    });
    expect(missing.map((file) => file.present)).toEqual([false, false]);
  });

  test("a file that is not a PE image is still listed, with the fields it could not supply left null", async () => {
    const runtime = runtimeTree({ "dlss/nvngx_dlss.dll": new Uint8Array(1_572_864) });
    const sr = (await runtimeReport(runtime)).files[1]!;
    expect(sr).toMatchObject({ name: "nvngx_dlss.dll", present: true, sizeMB: 1.5, version: null, exports: null });
  });

  test("the flat copy is the one listed when a version folder holds the same DLL, the version folder when it is alone", async () => {
    const both = runtimeTree({ "dlss/nvngx_dlss.dll": new Uint8Array(1), "dlss/310.7.0.0/nvngx_dlss.dll": new Uint8Array(1) });
    expect((await runtimeReport(both)).files[1]!.path).toBe(join(both, "dlss", "nvngx_dlss.dll"));
    const versioned = runtimeTree({ "dlss/310.7.0.0/nvngx_dlss.dll": new Uint8Array(1) });
    expect((await runtimeReport(versioned)).files[1]!.path).toBe(join(versioned, "dlss", "310.7.0.0", "nvngx_dlss.dll"));
  });

  test("is exactly the folder and files that make up the probe report's runtime section", async () => {
    const report = await runtimeReport(runtimeTree({}));
    expect(Object.keys(report)).toEqual(["folder", "files"]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
