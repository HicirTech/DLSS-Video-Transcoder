/**
 * How dlssgHost starts the DLSS Frame Generation host: the bun and script it runs, its folder and environment, the
 * hint, and the runtime key the caches use. No process is started.
 */
import { describe, expect, test } from "bun:test";
import { basename, isAbsolute, join, resolve } from "node:path";
import { HOST_PROCESS_NAME, dlssgHost, dlssgRuntimeKey } from "../src/pipeline/dlssg-host-launch.ts";

describe("dlssgHost", () => {
  test("the host runs under this bun with an absolute runtime root and without NGX's logging switches", () => {
    process.env.__NGX_LOG_LEVEL_FOR_TEST = "1";
    try {
      const host = dlssgHost({ root: join("some", "runtime") });
      const command = host.command({ mode: "--probe" });
      expect(command[0]).toBe(process.execPath);
      expect(command.slice(2, 4)).toEqual(["--probe", "--runtime"]);
      expect(isAbsolute(command[4]!)).toBe(true);
      expect(host.cwd).toBe(join("some", "runtime", "dlssg"));
      expect(Object.keys(host.env!).some((name) => name.toUpperCase().startsWith("__NGX_LOG_"))).toBe(false);
      expect(host.env!.PATH ?? host.env!.Path).toBeDefined();
    } finally {
      delete process.env.__NGX_LOG_LEVEL_FOR_TEST;
    }
  });

  test("the serve command names the shared memory, and the probe command does not", () => {
    const host = dlssgHost({ root: join("some", "runtime") });
    expect(host.command({ mode: "--serve", sharedMemoryName: "dlssg-fg-test" }).slice(-2)).toEqual(["--shared", "dlssg-fg-test"]);
    expect(host.command({ mode: "--probe" })).not.toContain("--shared");
  });

  test("the hint names the folder to check for nvngx_dlssg.dll and the folder the shim is written to", () => {
    const host = dlssgHost({ root: join("some", "runtime") });
    expect(host.hint).toContain(host.cwd);
    expect(host.hint).toContain(join(resolve(join("some", "runtime")), "caller"));
  });

  test("a version folder replaces dlssg/: the host runs in it and is told it as an absolute --dll-dir", () => {
    const dllDir = join("some", "versions", "310.6.0.0");
    const host = dlssgHost({ root: join("some", "runtime"), dllDir });
    expect(host.cwd).toBe(resolve(dllDir));
    expect(host.hint).toContain(resolve(dllDir));
    const serve = host.command({ mode: "--serve", sharedMemoryName: "dlssg-fg-test" });
    expect(serve.slice(2)).toEqual(["--serve", "--runtime", resolve(join("some", "runtime")), "--dll-dir", resolve(dllDir), "--shared", "dlssg-fg-test"]);
    expect(dlssgHost({ root: join("some", "runtime") }).command({ mode: "--probe" })).not.toContain("--dll-dir");
  });

  test("another version folder is another runtime to the caches, another spelling of the same one is not", () => {
    const root = join("some", "runtime");
    expect(dlssgRuntimeKey({ root, dllDir: join("v", "310.6") })).not.toBe(dlssgRuntimeKey({ root, dllDir: join("v", "310.7") }));
    expect(dlssgRuntimeKey({ root, dllDir: join("v", "310.6") })).not.toBe(dlssgRuntimeKey({ root }));
    expect(dlssgRuntimeKey({ root, dllDir: join("v", "x", "..", "310.6") })).toBe(dlssgRuntimeKey({ root: resolve(root), dllDir: resolve(join("v", "310.6")) }));
  });

  test("messages name the script the command runs", () => {
    expect(HOST_PROCESS_NAME).toContain(basename(dlssgHost({ root: "runtime" }).command({ mode: "--serve", sharedMemoryName: "dlssg-fg-test" })[1]!));
  });
});
