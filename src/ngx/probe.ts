/**
 * Hardware / driver / runtime probe. Every step is guarded so a failure in one
 * layer still yields a report that says exactly where things stopped.
 *
 * Set NR_TRACE=1 to print each native call to stderr before it happens; a
 * crash inside NVIDIA code then leaves the last trace line as the culprit.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { D3D12Device } from "../native/d3d12.ts";
import { DxgiFactory, selectAdapter, type DxgiAdapter } from "../native/dxgi.ts";
import { hex32 } from "../native/memory.ts";
import { readPeFile } from "../native/pe.ts";
import type { ProbeAdapter, ProbeFeature, ProbeReport, RuntimeFile } from "../server/api-types.ts";
import { FeatureCommonInfo, NgxCore, locateNgxCores } from "./core.ts";
import { prepareForwarder, selfTestForwarder } from "./forwarder-runtime.ts";
import { NgxParam, NgxParameters, NrParam } from "./params.ts";
import { NgxFeature, featureName, ngxName, ngxOk } from "./results.ts";
import { SpyParameter } from "./spy.ts";

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
  entry?: "core" | "loader";
  /** Pass NULL as Init_Ext's fifth argument (only for reproducing the driver fault). */
  nullFeatureInfo?: boolean;
  /** Which init export to exercise: Init_Ext with a FeatureCommonInfo, the 4-argument Init, or Init_Ext with a spy parameter object. */
  init?: "ext" | "plain" | "spy";
  debugLayer?: boolean;
}

export const PROBE_APP_ID = 0x4e5254530001n; // "NRTS" + 1, an arbitrary non-zero application id

const RUNTIME_FILES: { name: string; subdir: string; role: string }[] = [
  { name: "nvngx_dlssnr.dll", subdir: "dlssnr", role: "DLSS 5 Neural Rendering (feature 18)" },
  { name: "nvngx_dlss.dll", subdir: "dlss", role: "DLSS Super Resolution (feature 1)" },
  { name: "nvngx_dlssg.dll", subdir: "dlssg", role: "DLSS Frame Generation (feature 11)" },
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

async function inventory(runtimeDir: string): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = [];
  for (const { name, subdir, role } of RUNTIME_FILES) {
    // Each feature's DLL lives in its own subfolder; the flat layout is the
    // fallback for setups predating that split.
    const path = [join(runtimeDir, subdir, name), join(runtimeDir, name)].find((p) => existsSync(p)) ?? null;
    if (!path) {
      files.push({ name, role, present: false, path: null, sizeMB: null, version: null, exports: null });
      continue;
    }
    let exports: string[] | null = null;
    try {
      exports = (await readPeFile(path)).exports.map((e) => e.name);
    } catch {
      exports = null;
    }
    files.push({ name, role, present: true, path, sizeMB: Math.round((statSync(path).size / 1048576) * 10) / 10, version: null, exports });
  }
  return files;
}

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    trace(line);
  };
  const reasons: string[] = [];
  const runtimeDir = resolve(options.runtimeDir);
  const appDataPath = resolve(options.appDataPath);
  mkdirSync(appDataPath, { recursive: true });

  const report: ProbeReport = {
    ok: false,
    generatedAt: new Date().toISOString(),
    platform: { os: `${process.platform} ${require("node:os").release()}`, bun: Bun.version },
    adapters: [],
    selectedAdapter: null,
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
  let device: D3D12Device | null = null;
  try {
    trace("CreateDXGIFactory1");
    factory = DxgiFactory.create();
    adapters = factory.enumerate();
    report.adapters = adapters.map<ProbeAdapter>((a) => ({
      index: a.info.index,
      name: a.info.name,
      vendorId: a.info.vendorId,
      deviceId: a.info.deviceId,
      dedicatedVideoMemoryMB: a.info.dedicatedVideoMemoryMB,
      luid: a.info.luid,
      isNvidia: a.info.isNvidia,
      software: a.info.software,
    }));
    adapter = selectAdapter(adapters, options.adapterIndex);
    if (!adapter) {
      reasons.push("No NVIDIA GPU was found. DLSS requires an NVIDIA RTX GPU.");
      say("no NVIDIA adapter");
    } else {
      report.selectedAdapter = adapter.info.index;
      say(`selected adapter ${adapter.info.index}: ${adapter.info.name}`);
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

  // --- runtime folder ---
  report.runtime.files = await inventory(runtimeDir);
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
      report.driver.ngxCoreExports = (await readPeFile(location.path)).exports.map((e) => e.name);
    } catch (error) {
      say(`could not read NGX core exports: ${(error as Error).message}`);
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
      reasons.push(`DLSS capability query failed: ${(error as Error).message}`);
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
  // prerequisites instead — the DLL present, a D3D12 device, and a shim that both
  // loaded and passed its self-test (a loaded-but-broken shim cannot reach the
  // driver). CreateFeature(18) itself is left to the nr command and the pipeline:
  // running it in-process can destabilise a long-lived server.
  const forwarderOk = report.forwarder.loaded && Boolean(report.forwarder.selfTest?.startsWith("ok"));
  report.verdict.neuralRenderingReady =
    Boolean(dlssnr?.present) && forwarderOk && report.device.created && core !== null;
  if (!report.verdict.neuralRenderingReady && report.device.created && core !== null && dlssnr?.present && !forwarderOk)
    reasons.push("The DLSS runtime caller shim could not be loaded or failed its self-test.");
  report.ok = report.device.created && core !== null;

  // --- teardown ---
  // The driver's _nvngx.dll core releases the device inside Shutdown1, so a
  // second ID3D12Device::Release() double-frees it (a fault at a hooked vtable
  // slot). Release the device ourselves only when NGX never initialised.
  const ngxWasInitialised = core?.isInitialised ?? false;
  try {
    trace("NVSDK_NGX_D3D12_Shutdown1");
    core?.shutdown();
  } catch {
    /* ignore */
  }
  if (!ngxWasInitialised) device?.release();
  for (const a of adapters) a.release();
  factory?.release();
  return report;
}
