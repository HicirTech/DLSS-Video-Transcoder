/**
 * What the SR and NR sessions (src/ngx/sr.ts, src/ngx/nr-render.ts) refuse before they touch the GPU or NGX, so no
 * GPU is needed: the session stand-in is never reached.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DlssNrSession } from "../src/ngx/nr-render.ts";
import { DlssSrSession } from "../src/ngx/sr.ts";
import type { GpuSession } from "../src/pipeline/gpu.ts";
import { DEFAULT_NR_SETTINGS } from "../src/server/api-types.ts";

const UNREACHED_SESSION = {} as GpuSession;
const NOT_A_QUALITY_MODE = 9;

test("an SR session refuses a quality mode that has no preset parameter, naming the modes there are", () => {
  const open = () =>
    DlssSrSession.open(UNREACHED_SESSION, { renderWidth: 64, renderHeight: 64, outputWidth: 128, outputHeight: 128, quality: NOT_A_QUALITY_MODE, runtimeDir: "unused" });
  expect(open).toThrow(`DLSS SR: PerfQuality ${NOT_A_QUALITY_MODE} is not a quality mode; pass one of MaxPerf, Balanced, MaxQuality, UltraPerformance, UltraQuality, DLAA.`);
});

test("an NR session without its DLL names the file, the folder it looked in and how to supply one", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "nr-runtime-"));
  try {
    const open = () => DlssNrSession.open(UNREACHED_SESSION, { width: 64, height: 64, settings: DEFAULT_NR_SETTINGS, runtimeDir });
    expect(open).toThrow(`DLSS Neural Rendering needs nvngx_dlssnr.dll in ${join(runtimeDir, "dlssnr")}`);
    expect(open).toThrow("--nr-version or neuralRendering.dllDir");
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
