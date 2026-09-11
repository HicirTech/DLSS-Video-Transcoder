/**
 * Hardware / driver / runtime probe. Every step is guarded so a failure in one
 * layer still yields a report that says exactly where things stopped.
 *
 * Set NR_TRACE=1 to print each native call to stderr before it happens; a
 * crash inside NVIDIA code then leaves the last trace line as the culprit.
 */
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { D3D12Device } from "../native/d3d12.ts";
import { DxgiFactory, type DxgiAdapter } from "../native/dxgi.ts";
import { hex32 } from "../native/memory.ts";
import { parsePe } from "../native/pe.ts";
import { parseVersionInfo } from "../native/version-info.ts";
import { DEFAULT_FLOW_WIDTH, MIN_FLOW_SIDE } from "../pipeline/flow.ts";
import { chooseGpu, gpuCandidates } from "../pipeline/gpu.ts";
import { probeNvof } from "../pipeline/nvof.ts";
import { FEATURES, runtimeDllCandidates, type FeatureDescriptor, type FeatureKey } from "./runtime-catalog.ts";
import type { ProbeAdapter, ProbeFeature, ProbeReport, RuntimeFile } from "../server/api-types.ts";
import { FeatureCommonInfo, NgxCore, locateNgxCores } from "./core.ts";
import { prepareForwarder, selfTestForwarder } from "./forwarder-runtime.ts";
import { NgxParam, NgxParameters, NrParam } from "./params.ts";
import { NgxFeature, featureName, ngxName, ngxOk } from "./results.ts";
import { SpyParameter } from "./spy.ts";

/** The NGX module `--entry` can enter through; ProbeOptions derives its type so the two cannot drift. */
export const PROBE_ENTRIES = ["loader", "core"] as const;
export type ProbeEntry = (typeof PROBE_ENTRIES)[number];

/** The Init exports `--init` can exercise; see the branches in runProbe. */
export const PROBE_INITS = ["ext", "plain", "spy"] as const;
export type ProbeInit = (typeof PROBE_INITS)[number];

export interface ProbeOptions {
  adapterIndex?: number;
  /** Folder holding user-supplied NVIDIA runtime DLLs. */
  runtimeDir: string;
  /** Folder NGX may write logs into. */
  appDataPath: string;
  /** Also try NVSDK_NGX_D3D12_Init_ProjectID (opt-in; argument order is not in the public header). */
  projectInit?: boolean;
  /** Query GetFeatureRequirements (defaults to true; off to isolate crashes). */
  requirements?: boolean;
  /** Which NVIDIA module to enter through: the core itself or the driver's nvngx.dll loader. */
  entry?: ProbeEntry;
  /** Pass NULL as Init_Ext's fifth argument (only for reproducing the driver fault). */
  nullFeatureInfo?: boolean;
  /** Which init export to exercise: Init_Ext with a FeatureCommonInfo, the 4-argument Init, or Init_Ext with a spy parameter object. */
  init?: ProbeInit;
  debugLayer?: boolean;
}

export const PROBE_APP_ID = 0x4e5254530001n; // "NRTS" + 1, an arbitrary non-zero application id

const featureByKey = (key: FeatureKey): FeatureDescriptor => FEATURES.find((f) => f.key === key)!;

// Only the report's wording lives here. Which file each feature needs, and where
// it may sit under runtime/, is runtime-catalog.ts's rule — so the report and
// the version list cannot disagree about what is installed.
const RUNTIME_FILES: { feature: FeatureDescriptor; role: string }[] = [
  { feature: featureByKey("nr"), role: "DLSS 5 Neural Rendering (feature 18)" },
  { feature: featureByKey("sr"), role: "DLSS Super Resolution (feature 1)" },
  { feature: featureByKey("fg"), role: "DLSS Frame Generation (feature 11)" },
];

const TRACE = process.env.NR_TRACE === "1";

function trace(line: string): void {
  if (TRACE) console.error(`[probe] ${line}`);
}

function driverVersionFromSmi(): string | null {
  try {
    const proc = Bun.spawnSync(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    const text = new TextDecoder().decode(proc.stdout).trim().split(/\r?\n/)[0] ?? "";
    return text.length ? text : null;
  } catch {
    return null;
  }
}

/**
 * Which runtime DLLs the report lists, whether each is installed, and what the
 * installed copy is. Filesystem work only — no GPU, no native load — so it is
 * testable against a temporary runtime/ tree.
 */
export async function inventoryRuntimeFiles(runtimeDir: string): Promise<RuntimeFile[]> {
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

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    trace(line);
  };
  // Blocking failures only. The verdict carries this array, so every line in it
  // must be a reason a job would not run: openGpu would refuse the adapter (no
  // CUDA device, not NVIDIA), or feature 18 could not be created. A condition a
  // job survives by running slower (no hardware optical flow) is advisory and
  // goes to say().
  const reasons: string[] = [];
  const runtimeDir = resolve(options.runtimeDir);
  const appDataPath = resolve(options.appDataPath);
  mkdirSync(appDataPath, { recursive: true });
  // What the pipeline feeds NVOFA, so the report can say whether the engine's limits can ever matter.
  const pipelineGrid = { minSide: MIN_FLOW_SIDE, maxLongSide: DEFAULT_FLOW_WIDTH };

  const report: ProbeReport = {
    ok: false,
    generatedAt: new Date().toISOString(),
    platform: { os: `${process.platform} ${require("node:os").release()}`, bun: Bun.version },
    adapters: [],
    selectedAdapter: null,
    cuda: { deviceCount: null, error: null },
    opticalFlow: { status: "not queried", detail: "no adapter was selected", cudaOrdinal: null, limits: null, outGridSizes: null, pipelineGrid },
    device: { created: false, hresult: null, featureLevel: null },
    driver: { version: driverVersionFromSmi(), ngxCorePath: null, ngxCoreVersion: null, ngxCoreExports: [] },
    ngxInit: { attempted: false, result: null, ok: false },
    capabilities: {},
    features: [],
    runtime: { folder: runtimeDir, files: [] },
    forwarder: { path: null, generated: false, loaded: false, selfTest: null },
    verdict: { neuralRenderingReady: false, reasons },
    log,
  };

  // --- adapters + device ---
  let factory: DxgiFactory | null = null;
  let adapters: DxgiAdapter[] = [];
  let adapter: DxgiAdapter | null = null;
  let cudaOrdinal: number | null = null;
  let device: D3D12Device | null = null;
  try {
    trace("CreateDXGIFactory1");
    factory = DxgiFactory.create();
    adapters = factory.enumerate();
    trace("cuInit + cuDeviceGetLuid per CUDA device");
    const { candidates, cuda } = gpuCandidates(adapters);
    report.cuda = { deviceCount: cuda.deviceCount, error: cuda.error };
    say(cuda.error === null ? `CUDA lists ${cuda.deviceCount} device(s)` : `CUDA could not be queried: ${cuda.error}`);
    report.adapters = adapters.map<ProbeAdapter>((a, i) => ({
      index: a.info.index,
      name: a.info.name,
      vendorId: a.info.vendorId,
      deviceId: a.info.deviceId,
      dedicatedVideoMemoryMB: a.info.dedicatedVideoMemoryMB,
      luid: a.info.luid,
      isNvidia: a.info.isNvidia,
      software: a.info.software,
      cudaOrdinal: candidates[i]!.cudaOrdinal,
    }));
    // The same rule a job applies (openGpu), so the verdict here and a refusal
    // there can never disagree. An ineligible choice is still diagnosed below:
    // its D3D12 and NGX results are what a user needs to see next to the reason.
    const choice = chooseGpu(candidates, cuda, options.adapterIndex);
    for (const reason of choice.reasons) {
      reasons.push(reason);
      say(reason);
    }
    adapter = choice.index === null ? null : (adapters.find((a) => a.info.index === choice.index) ?? null);
    cudaOrdinal = choice.cudaOrdinal;
    if (adapter) {
      report.selectedAdapter = adapter.info.index;
      say(`selected adapter ${adapter.info.index}: ${adapter.info.name}${cudaOrdinal === null ? "" : ` (CUDA device ${cudaOrdinal})`}`);
      try {
        trace("D3D12CreateDevice");
        device = D3D12Device.create(adapter, { debugLayer: options.debugLayer });
        report.device = { created: true, hresult: "0x00000000", featureLevel: hex32(device.featureLevel) };
        say("D3D12 device created");
      } catch (error) {
        report.device = { created: false, hresult: (error as Error).message, featureLevel: null };
        reasons.push(`D3D12 device creation failed: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    reasons.push(`Could not list graphics adapters: ${(error as Error).message}`);
  }

  // --- hardware optical flow ---
  // Advisory, not a verdict reason: a video job with motion=flow falls back to
  // the CPU matcher when the engine is missing. It is reported so the fallback
  // message has a line to point at, and so the engine's limits are on record.
  if (cudaOrdinal === null) {
    report.opticalFlow.detail = adapter ? "the selected adapter has no CUDA device to ask on" : "no adapter was selected";
    say(`hardware optical flow (NVOFA) not queried: ${report.opticalFlow.detail}`);
  } else {
    trace(`probeNvof(${cudaOrdinal})`);
    const caps = probeNvof(cudaOrdinal);
    report.opticalFlow = { ...caps, cudaOrdinal, pipelineGrid };
    say(
      caps.status === "ok"
        ? `hardware optical flow (NVOFA) on CUDA device ${cudaOrdinal}: input ${caps.limits!.widthMin}..${caps.limits!.widthMax} x ${caps.limits!.heightMin}..${caps.limits!.heightMax} px, output grids ${caps.outGridSizes!.join(", ")}`
        : `hardware optical flow (NVOFA) unavailable on CUDA device ${cudaOrdinal}: ${caps.detail}`,
    );
  }

  // --- runtime folder ---
  report.runtime.files = await inventoryRuntimeFiles(runtimeDir);
  const dlssnr = report.runtime.files.find((f) => f.name === "nvngx_dlssnr.dll");
  if (!dlssnr?.present) reasons.push(`The DLSS Neural Rendering runtime file nvngx_dlssnr.dll was not found in ${runtimeDir}. Copy it into that folder.`);

  // --- NGX core ---
  let core: NgxCore | null = null;
  const locations = locateNgxCores();
  if (locations.length === 0) {
    reasons.push("No NGX core (_nvngx.dll) found; an NVIDIA driver is required");
  } else {
    const location = locations[0]!;
    report.driver.ngxCorePath = location.path;
    say(`NGX core: ${location.path} (${location.source}, ${locations.length} candidate${locations.length === 1 ? "" : "s"})`);
    try {
      // Version and exports come out of the same bytes, so the file is read once.
      // This is _nvngx.dll's own file version (e.g. 32.0.16.1664); nvidia-smi
      // calls that same driver 616.64, so the two rows differ by design.
      const bytes = new Uint8Array(await Bun.file(location.path).arrayBuffer());
      report.driver.ngxCoreVersion = parseVersionInfo(bytes).fileVersion;
      report.driver.ngxCoreExports = parsePe(bytes).exports.map((e) => e.name);
    } catch (error) {
      say(`could not read the NGX core's version and exports: ${(error as Error).message}`);
    }
    try {
      trace(`LoadLibraryExW ${location.path} (entry=${options.entry ?? "core"})`);
      core = NgxCore.load(location, options.entry ?? "core");
      report.driver.ngxCorePath = core.location.path;
      say(`NGX entry module loaded: ${core.location.path}`);
    } catch (error) {
      reasons.push(`NGX core failed to load: ${(error as Error).message}`);
    }
  }

  // --- forwarder shim: prepared before Init so every NGX call routes through nvngx.dll ---
  if (core) {
    try {
      const callerDir = join(runtimeDir, "caller");
      mkdirSync(callerDir, { recursive: true });
      trace("prepareForwarder");
      const { forwarder, wrote } = await prepareForwarder(callerDir);
      report.forwarder.path = forwarder.path;
      report.forwarder.generated = true;
      report.forwarder.loaded = true;
      core.useForwarder(forwarder);
      say(`DLSS runtime setup ${wrote ? "written" : "up to date"} and connected to the NVIDIA NGX core`);
      const test = selfTestForwarder(forwarder);
      report.forwarder.selfTest = `${test.ok ? "ok" : "FAILED"}: ${test.detail}`;
      say(`DLSS runtime self-test ${test.ok ? "passed" : "failed"}: ${test.detail}`);
      if (!test.ok) reasons.push("The DLSS runtime setup failed its self-test, so calls could not be routed to the NVIDIA driver.");
    } catch (error) {
      report.forwarder.selfTest = `error: ${(error as Error).message}`;
      reasons.push(`The DLSS runtime setup could not be completed: ${(error as Error).message}`);
    }
  }

  // --- Init first: the core keeps global state that later queries rely on ---
  if (core && device) {
    report.ngxInit.attempted = true;
    try {
      let result: number;
      const mode = options.init ?? "ext";
      if (mode === "plain") {
        trace("NVSDK_NGX_D3D12_Init (4 arguments)");
        result = core.initPlain(device.ptr, PROBE_APP_ID, appDataPath);
        say(`Init -> ${ngxName(result)}`);
      } else if (mode === "spy") {
        const spy = new SpyParameter();
        trace("NVSDK_NGX_D3D12_Init_Ext (fifth argument = spy vtable object)");
        result = core.initExtRaw(device.ptr, PROBE_APP_ID, appDataPath, spy.ptr);
        say(`Init_Ext(spy) -> ${ngxName(result)}; spy saw: ${spy.summary()}`);
        report.capabilities["spy.calls"] = spy.summary();
        spy.close(); // release the 32 JSCallback trampolines the spy vtable allocated
      } else {
        const featureInfo = options.nullFeatureInfo ? null : new FeatureCommonInfo([runtimeDir]);
        trace(`NVSDK_NGX_D3D12_Init_Ext (featureInfo=${featureInfo ? "struct with 1 search path" : "NULL"})`);
        result = core.initExt(device.ptr, PROBE_APP_ID, appDataPath, featureInfo);
        say(`Init_Ext -> ${ngxName(result)}`);
      }
      if (!ngxOk(result) && options.projectInit) {
        trace("NVSDK_NGX_D3D12_Init_ProjectID");
        result = core.initProjectId(device.ptr, "b0c4f6a2-7c3e-4a3f-9f1e-0a6d2e9c1b45", "0.1", appDataPath, new FeatureCommonInfo([runtimeDir]));
        say(`Init_ProjectID -> ${ngxName(result)}`);
      }
      report.ngxInit.result = ngxName(result);
      report.ngxInit.ok = ngxOk(result);
      if (!ngxOk(result)) reasons.push(`NVIDIA NGX runtime initialization failed: ${ngxName(result)}`);
    } catch (error) {
      report.ngxInit.result = (error as Error).message;
      reasons.push(`NVIDIA NGX runtime initialization failed: ${(error as Error).message}`);
    }
  }

  // --- capability parameters ---
  if (core && report.ngxInit.ok) {
    try {
      trace("NVSDK_NGX_D3D12_GetCapabilityParameters");
      const caps = core.capabilityParameters();
      trace("NgxParameters.detectLayout");
      const layout = NgxParameters.detectLayout(caps);
      report.capabilities["NgxParameters.vtableLayout"] = layout;
      say(`parameter memory layout: ${layout}`);
      const readNames: string[] = [
        NgxParam.SuperSamplingAvailable,
        NgxParam.SuperSamplingNeedsUpdatedDriver,
        NgxParam.SuperSamplingMinDriverVersionMajor,
        NgxParam.SuperSamplingMinDriverVersionMinor,
        NgxParam.SuperSamplingFeatureInitResult,
        NgxParam.FrameGenerationAvailable,
        NgxParam.FrameGenerationNeedsUpdatedDriver,
        NgxParam.FrameGenerationMinDriverVersionMajor,
        NgxParam.FrameGenerationMinDriverVersionMinor,
        NgxParam.RayReconstructionAvailable,
        NrParam.Available,
        NrParam.NeedsUpdatedDriver,
        NrParam.MinDriverVersionMajor,
        NrParam.MinDriverVersionMinor,
        NrParam.FeatureInitResult,
        NgxParam.SnippetOptLevel,
        NgxParam.SnippetIsDevBranch,
      ];
      if (layout !== "unknown") {
        for (const name of readNames) {
          trace(`Get ${name}`);
          report.capabilities[name] = caps.getU32(name);
        }
      } else {
        say("skipping capability reads: the parameter memory layout could not be confirmed");
      }
    } catch (error) {
      // Advisory: these parameters describe the runtime, they do not gate it.
      say(`capability query failed: ${(error as Error).message}`);
    }
  }

  // --- feature requirements ---
  if (core && adapter && (options.requirements ?? true)) {
    const searchPaths = new FeatureCommonInfo([runtimeDir]);
    for (const id of [NgxFeature.SuperSampling, NgxFeature.FrameGeneration, NgxFeature.RayReconstruction, NgxFeature.NeuralRendering]) {
      const feature: ProbeFeature = {
        id,
        name: featureName(id),
        support: "not queried",
        supportCode: null,
        minHwArchitecture: null,
        minOsVersion: null,
        detail: "",
      };
      try {
        trace(`NVSDK_NGX_D3D12_GetFeatureRequirements(${id})`);
        const r = core.featureRequirements(adapter.ptr, id, PROBE_APP_ID, appDataPath, searchPaths);
        feature.support = r.support;
        feature.supportCode = r.supportedBits;
        feature.minHwArchitecture = r.minHwArchitecture;
        feature.minOsVersion = r.minOsVersion;
        feature.detail = `GetFeatureRequirements -> ${ngxName(r.result)}`;
        // NotImplemented here means the driver declines to answer, not that the
        // feature is missing — the features still work, so do not say "query
        // failed". Readiness is judged from the prerequisites below.
        if ((r.result >>> 0) === 0xbad00012) feature.support = "not reported by this driver";
      } catch (error) {
        feature.support = "query failed";
        feature.detail = (error as Error).message;
      }
      report.features.push(feature);
      say(`feature ${id} ${feature.name}: ${feature.support} (${feature.detail})`);
    }
  }

  // --- verdict ---
  // GetFeatureRequirements returns NotImplemented for every feature on this
  // driver, so it cannot confirm feature 18; readiness is judged on the real
  // prerequisites instead — an adapter a job would accept (a CUDA device behind
  // it, as chooseGpu requires), the DLL present, a D3D12 device, and a shim that
  // both loaded and passed its self-test (a loaded-but-broken shim cannot reach
  // the driver). CreateFeature(18) itself is left to the nr command and the
  // pipeline: running it in-process can destabilise a long-lived server.
  // Init belongs here: it runs whenever core and device exist, and leaving it out
  // let the report say YES while listing an Init failure underneath.
  const forwarderOk = report.forwarder.loaded && Boolean(report.forwarder.selfTest?.startsWith("ok"));
  const prerequisites =
    cudaOrdinal !== null && Boolean(dlssnr?.present) && forwarderOk && report.device.created && core !== null && report.ngxInit.ok;
  // Both halves: the prerequisites are what readiness means, and an empty reason
  // list is what makes the verdict and the text under it agree. A failure that
  // pushes a reason without clearing a prerequisite still blocks.
  report.verdict.neuralRenderingReady = prerequisites && reasons.length === 0;
  report.ok = report.device.created && core !== null;

  // --- teardown ---
  // Never Shutdown1 here. On this driver core it releases the D3D12 device
  // itself and leaves D3D12 unable to make another on the same adapter: the next
  // D3D12CreateDevice in the process faults inside D3D12Core (measured — a
  // second runProbe, or a job after a probe, died there, which is what the
  // server does per /api/probe request; issue #75). sr.ts and nr-render.ts
  // leave NGX to process exit for the same reason, so the probe does too and
  // releases only what it owns. Measured: three consecutive probes in one
  // process then each get a fresh device.
  device?.release();
  for (const a of adapters) a.release();
  factory?.release();
  return report;
}
