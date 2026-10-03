import { expect, test } from "bun:test";
import { join } from "node:path";
import { APP_DATA_DIR, callerDir, DEFAULT_RUNTIME_DIR, featureDir, PROJECT_ROOT } from "../src/paths.ts";

test("the default runtime folder is <repo>/runtime and the default app-data folder <repo>/logs", () => {
  expect(DEFAULT_RUNTIME_DIR).toBe(join(PROJECT_ROOT, "runtime"));
  // Unless NR_APPDATA overrides it, which the unit suite does not set.
  if (!process.env.NR_APPDATA) expect(APP_DATA_DIR).toBe(join(PROJECT_ROOT, "logs"));
});

test("the caller shim and each feature have their own folder under the runtime folder", () => {
  const runtime = join("some", "runtime");
  expect(callerDir(runtime)).toBe(join(runtime, "caller"));
  expect(featureDir(runtime, "sr")).toBe(join(runtime, "dlss"));
  expect(featureDir(runtime, "nr")).toBe(join(runtime, "dlssnr"));
  expect(featureDir(runtime, "fg")).toBe(join(runtime, "dlssg"));
  expect(featureDir(runtime, "rr")).toBe(join(runtime, "dlssd"));
});
