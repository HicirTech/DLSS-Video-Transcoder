/*
 * Static mock answers for the read-only endpoints: hardware probe, tools, runtime catalog, upload and
 * settings defaults. No DOM dependency, so the Bun mock server (web/mock-server.ts) and the browser
 * (`?mock=1`) share them.
 */
import type { RuntimeManifest } from "../../../src/ngx/runtime-catalog";
import type { ProbeReport, SettingsDefaults, ToolsReport, UploadResult } from "../../../src/server/api-types";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS } from "../../../src/server/api-types";

const RUNTIME_FOLDER = "C:\\Tools\\neural-render\\runtime";
const DRIVER_STORE = "C:\\Windows\\System32\\DriverStore\\FileRepository\\nvlti.inf_amd64_3f1c2b7e9d0a4c55";

export const MOCK_PROBE: ProbeReport = {
  ok: true,
  generatedAt: "2026-09-08T04:12:37.412Z",
  platform: { os: "Windows 11 Pro 10.0.26200", bun: "1.4.2" },
  adapters: [
    {
      index: 0,
      name: "NVIDIA RTX 2000 Ada Generation Laptop GPU",
      vendorId: 0x10de,
      deviceId: 0x28b8,
      dedicatedVideoMemoryMB: 8188,
      luid: "0x0000000000011F3A",
      isNvidia: true,
      software: false,
      cudaOrdinal: 0,
      cudaUuid: "GPU-2f6b1c3e-9a4d-4b7e-8c1a-5d2e3f4a6b7c",
      eligible: true,
    },
    {
      index: 1,
      name: "Intel(R) Iris(R) Xe Graphics",
      vendorId: 0x8086,
      deviceId: 0xa7a0,
      dedicatedVideoMemoryMB: 128,
      luid: "0x000000000001204C",
      isNvidia: false,
      software: false,
      cudaOrdinal: null,
      cudaUuid: null,
      eligible: false,
    },
    {
      index: 2,
      name: "Microsoft Basic Render Driver",
      vendorId: 0x1414,
      deviceId: 0x008c,
      dedicatedVideoMemoryMB: 0,
      luid: "0x0000000000012A11",
      isNvidia: false,
      software: true,
      cudaOrdinal: null,
      cudaUuid: null,
      eligible: false,
    },
  ],
  selectedAdapter: 0,
  cuda: { deviceCount: 1, error: null },
  opticalFlow: {
    status: "ok",
    detail: "ok",
    cudaOrdinal: 0,
    limits: { widthMin: 32, widthMax: 8192, heightMin: 32, heightMax: 8192 },
    outGridSizes: [1, 2, 4],
    pipelineGrid: { minSide: 64, maxLongSide: 640 },
  },
  device: { created: true, hresult: "0x00000000", featureLevel: "D3D_FEATURE_LEVEL_12_2" },
  driver: {
    version: "596.72",
    ngxCorePath: `${DRIVER_STORE}\\_nvngx.dll`,
    ngxCoreVersion: "596.72.0.0",
    ngxCoreExports: [
      "NVSDK_NGX_D3D12_Init",
      "NVSDK_NGX_D3D12_Init_Ext",
      "NVSDK_NGX_D3D12_Shutdown1",
      "NVSDK_NGX_D3D12_GetCapabilityParameters",
      "NVSDK_NGX_D3D12_AllocateParameters",
      "NVSDK_NGX_D3D12_DestroyParameters",
      "NVSDK_NGX_D3D12_GetScratchBufferSize",
      "NVSDK_NGX_D3D12_CreateFeature",
      "NVSDK_NGX_D3D12_EvaluateFeature",
      "NVSDK_NGX_D3D12_ReleaseFeature",
    ],
  },
  ngxInit: { attempted: true, result: "NVSDK_NGX_Result_Success (0x1)", ok: true },
  capabilities: {
    "SuperSampling.Available": 1,
    "SuperSampling.NeedsUpdatedDriver": 0,
    "SuperSampling.MinDriverVersionMajor": 512,
    "SuperSampling.MinDriverVersionMinor": 15,
    "FrameGeneration.Available": 1,
    "FrameGeneration.NeedsUpdatedDriver": 0,
    "RayReconstruction.Available": 1,
    "NeuralRendering.Available": 0,
    "NeuralRendering.NeedsUpdatedDriver": 1,
    "NeuralRendering.MinDriverVersionMajor": 600,
    "NeuralRendering.MinDriverVersionMinor": 10,
    "NeuralRendering.FeatureInitResult": "NVSDK_NGX_Result_FAIL_OutOfDate (0xBAD00003)",
    "Snippet.OptLevel": null,
  },
  features: [
    {
      id: 1,
      name: "DLSS Super Resolution",
      support: "supported",
      supportCode: 1,
      minHwArchitecture: 0x160,
      minOsVersion: "10.0.19041",
      detail: "Available=1, NeedsUpdatedDriver=0, snippet 310.3.0 loadable",
    },
    {
      id: 11,
      name: "DLSS Frame Generation",
      support: "supported",
      supportCode: 1,
      minHwArchitecture: 0x400,
      minOsVersion: "10.0.19041",
      detail: "Available=1 on Ada (AD107), optical flow accelerator present",
    },
    {
      id: 13,
      name: "DLSS Ray Reconstruction",
      support: "supported",
      supportCode: 1,
      minHwArchitecture: 0x160,
      minOsVersion: "10.0.19041",
      detail: "Available=1, NeedsUpdatedDriver=0",
    },
    {
      id: 18,
      name: "DLSS Neural Rendering",
      support: "driver too old",
      supportCode: 2,
      minHwArchitecture: 0x400,
      minOsVersion: "10.0.22621",
      detail: "NeedsUpdatedDriver=1: minimum driver 600.10, installed 596.72; feature init returned FAIL_OutOfDate",
    },
  ],
  runtime: {
    folder: RUNTIME_FOLDER,
    files: [
      {
        name: "nvngx_dlss.dll",
        role: "Super resolution runtime (feature 1)",
        present: true,
        path: `${RUNTIME_FOLDER}\\nvngx_dlss.dll`,
        sizeMB: 41.3,
        version: "310.3.0.0",
        exports: ["NVSDK_NGX_D3D12_CreateFeature1", "NVSDK_NGX_D3D12_EvaluateFeature1", "NVSDK_NGX_GetSnippetVersion"],
      },
      {
        name: "nvngx_dlssg.dll",
        role: "Frame generation runtime (feature 11)",
        present: true,
        path: `${RUNTIME_FOLDER}\\nvngx_dlssg.dll`,
        sizeMB: 23.9,
        version: "310.3.0.0",
        exports: ["NVSDK_NGX_D3D12_CreateFeature1", "NVSDK_NGX_D3D12_EvaluateFeature1", "NVSDK_NGX_GetSnippetVersion"],
      },
      {
        name: "nvngx_dlssd.dll",
        role: "Ray reconstruction runtime (feature 13)",
        present: true,
        path: `${RUNTIME_FOLDER}\\nvngx_dlssd.dll`,
        sizeMB: 62.1,
        version: "310.3.0.0",
        exports: ["NVSDK_NGX_D3D12_CreateFeature1", "NVSDK_NGX_D3D12_EvaluateFeature1", "NVSDK_NGX_GetSnippetVersion"],
      },
      {
        name: "nvngx_dlssnr.dll",
        role: "Neural rendering runtime (feature 18)",
        present: false,
        path: null,
        sizeMB: null,
        version: null,
        exports: null,
      },
      {
        name: "ngx_forwarder.dll",
        role: "Generated NGX forwarder used by bun:ffi",
        present: true,
        path: `${RUNTIME_FOLDER}\\ngx_forwarder.dll`,
        sizeMB: 0.2,
        version: "0.1.0",
        exports: ["nrfwd_init", "nrfwd_selftest", "nrfwd_create_feature", "nrfwd_evaluate", "nrfwd_release"],
      },
    ],
  },
  forwarder: {
    path: `${RUNTIME_FOLDER}\\ngx_forwarder.dll`,
    generated: true,
    loaded: true,
    selfTest: "ok: 5/5 exports resolved, round-trip call returned 0x1 in 0.8 ms",
  },
  verdict: {
    neuralRenderingReady: false,
    reasons: [
      "NGX feature 18 (neural rendering) reports 'driver too old': installed driver 596.72 is below the 600.10 minimum the core requires.",
      "nvngx_dlssnr.dll is missing from the runtime folder, so the snippet path cannot be used as a fallback.",
      "Everything else passed: D3D12 device at feature level 12_2, NGX core initialised, forwarder self-test ok.",
    ],
  },
  log: [
    "[00:00.002] probe: enumerating DXGI adapters (IDXGIFactory6, high-performance preference)",
    "[00:00.011] adapter 0: NVIDIA RTX 2000 Ada Generation Laptop GPU (10de:28b8) 8188 MB",
    "[00:00.011] adapter 1: Intel(R) Iris(R) Xe Graphics (8086:a7a0) 128 MB",
    "[00:00.012] adapter 2: Microsoft Basic Render Driver (1414:008c) software",
    "[00:00.013] selecting adapter 0",
    "[00:00.148] D3D12CreateDevice -> 0x00000000, feature level 12_2",
    "[00:00.152] driver version from registry: 596.72",
    "[00:00.161] NGX core located: " + DRIVER_STORE + "\\_nvngx.dll (596.72.0.0)",
    "[00:00.170] resolved 10 NGX core exports",
    "[00:00.171] NVSDK_NGX_D3D12_Init_Ext(app=0x4e52, log=" + RUNTIME_FOLDER + "\\logs) -> Success",
    "[00:00.203] NVSDK_NGX_D3D12_GetCapabilityParameters -> Success (13 parameters)",
    "[00:00.204] SuperSampling.Available=1 NeedsUpdatedDriver=0",
    "[00:00.204] FrameGeneration.Available=1",
    "[00:00.204] RayReconstruction.Available=1",
    "[00:00.205] NeuralRendering.Available=0 NeedsUpdatedDriver=1 MinDriverVersion=600.10",
    "[00:00.231] feature 18 trial CreateFeature -> NVSDK_NGX_Result_FAIL_OutOfDate (0xBAD00003)",
    "[00:00.240] runtime folder " + RUNTIME_FOLDER + ": 4 of 5 expected files present",
    "[00:00.241] missing: nvngx_dlssnr.dll",
    "[00:00.266] forwarder ngx_forwarder.dll loaded via bun:ffi, self-test ok",
    "[00:00.267] teardown: D3D12 device released; NGX stays loaded until the process exits (no Shutdown1)",
    "[00:00.268] verdict: neural rendering NOT ready (2 blocking reasons)",
  ],
};

export const MOCK_TOOLS: ToolsReport = {
  ffmpeg: { path: null, version: null },
  ffprobe: { path: null, version: null },
  nvenc: null,
};

/** Installed DLSS runtimes, as GET /api/catalog would report them. Shared by both mock modes. */
export function mockCatalog(): RuntimeManifest {
  return {
    features: [
      { id: 1, name: "DLSS Super Resolution", dllName: "nvngx_dlss.dll", versions: [
        { version: "310.7.0.0", path: "C:\\mock\\dlss\\nvngx_dlss.dll", sizeMB: 70.8, dir: "C:\\mock\\dlss", source: "runtime", sortKey: "0" },
        { version: "310.6.0.0", path: "C:\\mock\\swapper\\nvngx_dlss.dll", sizeMB: 70.1, dir: "C:\\mock\\swapper", source: "swapper", sortKey: "0" },
      ] },
      { id: 18, name: "DLSS Neural Rendering", dllName: "nvngx_dlssnr.dll", versions: [
        { version: "1.0.0.0", path: "C:\\mock\\dlssnr\\nvngx_dlssnr.dll", sizeMB: 158, dir: "C:\\mock\\dlssnr", source: "runtime", sortKey: "0" },
      ] },
    ],
  };
}

/** What POST /api/upload answers. The real server renames the file; the mock only has to be shaped like it. */
export function mockUpload(file: Pick<File, "name" | "size">): UploadResult {
  return { path: `C:\\mock\\uploads\\${file.name}`, name: file.name, size: file.size };
}

export function mockSettingsDefaults(): SettingsDefaults {
  return {
    settings: { ...DEFAULT_NR_SETTINGS },
    scale: { ...DEFAULT_SCALE_SETTINGS },
    encode: { ...DEFAULT_ENCODE_SETTINGS },
  };
}
