/**
 * DlssgFeature's placement rule for the nvngx.dll caller shim: it is generated apart from the
 * runtime's own files, so both entry points refuse the runtime folder before touching the GPU.
 */
import { describe, expect, test } from "bun:test";
import { DlssgFeature } from "../src/ngx/dlssg-feature.ts";
import type { GpuSession } from "../src/pipeline/gpu.ts";

// The placement check runs before the session is used, so no GPU is needed to reach it.
const unusedSession = {} as GpuSession;
const frameSize = { width: 1280, height: 720, maxGenerated: 3 };

describe("DlssgFeature caller shim placement", () => {
  test("open() refuses a caller folder that is the runtime folder", () => {
    expect(() => DlssgFeature.open(unusedSession, { ...frameSize, runtimeDir: "C:/rt/dlssg", callerDir: "C:/rt/dlssg" })).toThrow(/caller shim folder is the runtime folder/);
  });

  test("probe() refuses it too", () => {
    expect(() => DlssgFeature.probe(unusedSession, { runtimeDir: "C:/rt/dlssg", callerDir: "C:/rt/dlssg" })).toThrow(/caller shim folder is the runtime folder/);
  });

  test("the same folder spelled with other case, separators or a trailing separator is still refused", () => {
    expect(() => DlssgFeature.open(unusedSession, { ...frameSize, runtimeDir: "C:/rt/dlssg", callerDir: "c:\\RT\\Dlssg\\" })).toThrow(/caller shim folder is the runtime folder/);
  });
});
