/**
 * How the DLSS Frame Generation host process, dlssg-host.ts run by bun.exe, is started, and what to
 * tell the user when it fails.
 */
import { join, resolve } from "node:path";
import { callerDir, featureDir } from "../paths.ts";
import type { DlssgLaunch } from "./dlssg-protocol.ts";

/** What messages call the host process: its script, and the image Task Manager lists it under. */
export const HOST_PROCESS_NAME = "DLSS Frame Generation host process (dlssg-host.ts, run by bun.exe)";

export interface DlssgHost {
  /** The folder holding nvngx_dlssg.dll, where the process runs. */
  readonly cwd: string;
  /** The process's environment, or undefined to inherit this one's. */
  readonly env: Record<string, string> | undefined;
  /** What to check before running the job again, appended to every message about the process failing or stopping. */
  readonly hint: string;
  /** The command line that starts the process as `launch` says; dlssg-host.ts parses it. */
  command(launch: DlssgLaunch): string[];
}

/** Where a host loads DLSS Frame Generation from. */
export interface DlssgRuntime {
  /** The runtime folder holding dlssg/ and caller/. */
  readonly root: string;
  /** A DLSS Frame Generation version folder from the runtime catalog (JobRequest.dllDir) to load instead of dlssg/; absent for the bundled DLL. */
  readonly dllDir?: string;
}

/** One string per runtime, for the caches that remember what a runtime did: the same root with another version folder is another runtime. */
export function dlssgRuntimeKey(runtime: DlssgRuntime): string {
  return `${resolve(runtime.root)}|${runtime.dllDir === undefined ? "" : resolve(runtime.dllDir)}`;
}

const HOST_ENTRY = join(import.meta.dir, "dlssg-host.ts");

/**
 * The environment without NGX's logging switches. With them set, NGX writes its log to the
 * console from native code, which the host's stdout guard (dlssg-serve.ts claimStdout) cannot
 * intercept, and every stray byte on stdout desynchronises the protocol. Windows names are
 * case-insensitive, so the match is too.
 */
function withoutNgxLogging(environment: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) if (value !== undefined && !/^__NGX_LOG_/i.test(name)) kept[name] = value;
  return kept;
}

/** The host process that loads DLSS Frame Generation from `runtime`. */
export function dlssgHost(runtime: DlssgRuntime): DlssgHost {
  // dlssg-host.ts refuses a relative --runtime or --dll-dir: the host runs in cwd, not in this process's folder.
  const absoluteRoot = resolve(runtime.root);
  const dllDir = runtime.dllDir === undefined ? undefined : resolve(runtime.dllDir);
  const cwd = dllDir ?? featureDir(runtime.root, "fg");
  return {
    cwd,
    env: withoutNgxLogging(process.env),
    hint: `Check that ${cwd} holds nvngx_dlssg.dll, that ${callerDir(absoluteRoot)} can be written, and that your GPU driver is up to date, then run the job again.`,
    command: (launch) => [
      process.execPath, HOST_ENTRY, launch.mode, "--runtime", absoluteRoot,
      ...(dllDir === undefined ? [] : ["--dll-dir", dllDir]),
      ...(launch.mode === "--serve" ? ["--shared", launch.sharedMemoryName] : []),
    ],
  };
}
