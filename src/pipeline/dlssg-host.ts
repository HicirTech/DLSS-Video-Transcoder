/**
 * The DLSS Frame Generation host, a child process of the server: `--probe` prints the one-line JSON
 * probeDlssgHost parses, and `--serve` answers the dlssg protocol (dlssg-protocol.ts) with
 * DlssgFeature generating in this process, reading frames from and writing generated frames to the
 * shared memory the server created. USAGE below is its command line.
 */
import { isAbsolute, join } from "node:path";
import { readVersionInfo } from "../native/version-info.ts";
import { DlssgFeature, DlssgUnavailableError, capabilityRefusal, type DlssgRuntimeOptions } from "../ngx/dlssg-feature.ts";
import { featureByKey } from "../ngx/runtime-catalog.ts";
import { callerDir, featureDir, RUNTIME_DIR } from "../paths.ts";
import { HostStatus, encodeProbeLine, type DlssgLaunch, type DlssgProbeLine, type DlssgSetup } from "./dlssg-protocol.ts";
import { claimStdout, logToStderr, serveDlssg, type GeneratorOpening } from "./dlssg-serve.ts";
import { openGpu, type GpuSession } from "./gpu.ts";

const FRAME_GENERATION = featureByKey("fg");
/** The probe's worker_version. probeDlssg keeps only a probe that names one. */
const HOST_VERSION = "dlssg-host";
const USAGE =
  "usage: bun src/pipeline/dlssg-host.ts --probe|--serve [--runtime <absolute folder holding dlssg/ and caller/, default runtime/>] [--shared <name of the shared frame memory the parent created; required by --serve, refused by --probe>]";

/** The `--name value` pairs of `args`, or null when an argument is not such a pair, is not in `allowed`, or repeats. */
function optionValues(args: readonly string[], allowed: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at]!;
    const value = args[at + 1];
    if (!allowed.includes(name) || value === undefined || values.has(name)) return null;
    values.set(name, value);
  }
  return values;
}

function parseArguments(args: readonly string[]): { launch: DlssgLaunch; runtime: DlssgRuntimeOptions } | string {
  const mode = args[0];
  if (mode !== "--probe" && mode !== "--serve") return USAGE;
  const options = optionValues(args.slice(1), mode === "--serve" ? ["--runtime", "--shared"] : ["--runtime"]);
  if (!options) return USAGE;
  const runtimeRoot = options.get("--runtime") ?? RUNTIME_DIR;
  // The parent picks the host's working folder (DlssgSession starts its process in runtime/dlssg),
  // so a relative root would resolve against a folder the parent never meant.
  if (!isAbsolute(runtimeRoot)) return `--runtime must be an absolute path, got "${runtimeRoot}". ${USAGE}`;
  // The same layout sr.ts, nr-render.ts and probe.ts use: the feature's own folder is its NGX
  // search path, and the caller shim sits beside it, never inside it (DlssgFeature refuses that).
  const runtime = { runtimeDir: featureDir(runtimeRoot, "fg"), callerDir: callerDir(runtimeRoot) };
  if (mode === "--probe") return { launch: { mode }, runtime };
  const sharedMemoryName = options.get("--shared");
  if (!sharedMemoryName) return `--serve needs --shared, the name of the shared frame memory the parent created. ${USAGE}`;
  return { launch: { mode, sharedMemoryName }, runtime };
}

/**
 * The version resource of the nvngx_dlssg.dll in the search path, read from the file without
 * loading it. NGX loads that copy in preference to the driver's own (NGX logs on driver 616.92,
 * with 310.9.1 and with 310.7.129 in the search path), so it is the version the probe describes.
 */
async function runtimeVersion(runtime: DlssgRuntimeOptions): Promise<string> {
  try {
    return (await readVersionInfo(join(runtime.runtimeDir, FRAME_GENERATION.dllName))).fileVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function probe(runtime: DlssgRuntimeOptions): Promise<DlssgProbeLine> {
  const version = await runtimeVersion(runtime);
  const unavailable = (detail: string): DlssgProbeLine => ({ available: false, multiFrameCountMax: 0, runtimeVersion: version, workerVersion: HOST_VERSION, detail });
  let session: GpuSession;
  try {
    session = openGpu();
  } catch (error) {
    return unavailable((error as Error).message);
  }
  try {
    const capabilities = DlssgFeature.probe(session, runtime);
    const most = capabilities.multiFrameCountMax;
    const refused = capabilityRefusal(capabilities, 1);
    return {
      available: refused === null,
      multiFrameCountMax: most,
      runtimeVersion: version,
      workerVersion: HOST_VERSION,
      detail: refused ? `DLSS Frame Generation is unavailable: ${refused.detail}` : `nvngx_dlssg.dll ${version} in ${runtime.runtimeDir} generates up to ${most} frame(s) per interval (${most + 1}x)`,
    };
  } catch (error) {
    return unavailable(`NGX could not start DLSS Frame Generation from ${runtime.runtimeDir}: ${(error as Error).message}`);
  } finally {
    session.close();
  }
}

function refusalStatus(error: unknown): number {
  if (!(error instanceof DlssgUnavailableError)) return HostStatus.setupFailed;
  return error.reason === "tooManyGenerated" ? HostStatus.tooManyGenerated : HostStatus.unavailable;
}

/** A GPU still running a submit whose wait timed out may still use the session, so the process exit releases it then. */
function closeUnlessBusy(session: GpuSession): void {
  if (session.gpu.idle) session.close();
}

function openFeature(setup: DlssgSetup, runtime: DlssgRuntimeOptions): GeneratorOpening {
  let session: GpuSession;
  try {
    session = openGpu();
  } catch (error) {
    return { outcome: "refused", status: HostStatus.setupFailed, reason: (error as Error).message };
  }
  try {
    const feature = DlssgFeature.open(session, { ...runtime, width: setup.width, height: setup.height, maxGenerated: setup.generatedCount });
    const generator = {
      maximum: feature.capabilities.multiFrameCountMax,
      interval: feature.interval.bind(feature),
      close: () => {
        try {
          feature.close();
        } finally {
          closeUnlessBusy(session);
        }
      },
    };
    return { outcome: "opened", generator };
  } catch (error) {
    closeUnlessBusy(session);
    return { outcome: "refused", status: refusalStatus(error), reason: (error as Error).message };
  }
}

async function main(): Promise<number> {
  const stdout = claimStdout();
  const parsed = parseArguments(process.argv.slice(2));
  if (typeof parsed === "string") {
    logToStderr(parsed);
    return 2;
  }
  try {
    if (parsed.launch.mode === "--probe") {
      stdout.write(`${encodeProbeLine(await probe(parsed.runtime))}\n`);
      return 0;
    }
    return serveDlssg(stdout, parsed.launch.sharedMemoryName, (setup) => openFeature(setup, parsed.runtime));
  } catch (error) {
    logToStderr((error as Error).stack ?? String(error));
    return 1;
  }
}

process.exit(await main());
