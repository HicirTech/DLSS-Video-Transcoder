import type { JobRequest, JobStatus, ProbeReport, ToolsReport, WsEvent } from "../../src/server/api-types";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS } from "../../src/server/api-types";
import type { ApiClient, JobEventSource, SettingsDefaults } from "./api";
import { ApiError } from "./errors";

/*
 * Mock data and a small in-memory job engine. This module has no DOM dependency so the
 * Bun mock server (web/mock-server.ts) and the browser (`?mock=1`) share it.
 */

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
    },
  ],
  selectedAdapter: 0,
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
    "[00:00.267] NVSDK_NGX_D3D12_Shutdown1 -> Success",
    "[00:00.268] verdict: neural rendering NOT ready (2 blocking reasons)",
  ],
};

export const MOCK_TOOLS: ToolsReport = {
  ffmpeg: { path: null, version: null },
  ffprobe: { path: null, version: null },
  nvenc: null,
};

export function mockSettingsDefaults(): SettingsDefaults {
  return {
    settings: { ...DEFAULT_NR_SETTINGS },
    scale: { ...DEFAULT_SCALE_SETTINGS },
    encode: { ...DEFAULT_ENCODE_SETTINGS },
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

/** A handful of jobs in every state; the running and queued ones keep moving inside MockJobEngine. */
export function createSeedJobs(now: number = Date.now()): JobStatus[] {
  const at = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString();
  return [
    {
      id: "job-a1f3",
      kind: "image",
      input: "C:\\Users\\tim\\Pictures\\lake-sunrise.png",
      output: "C:\\Users\\tim\\Pictures\\lake-sunrise-nr.png",
      engine: "nr",
      state: "done",
      progress: 1,
      message: "Done",
      framesDone: 1,
      framesTotal: 1,
      fps: null,
      createdAt: at(1900),
      startedAt: at(1898),
      finishedAt: at(1895),
      error: null,
      log: [
        "[queue] image job accepted (engine=nr, motion=none, scale=factor)",
        "[ngx] D3D12 device ready on adapter 0, NVSDK_NGX_D3D12_CreateFeature(18) ok",
        "[nr] warm-up evaluation 4/4, temporal state settled",
        "[io] wrote C:\\Users\\tim\\Pictures\\lake-sunrise-nr.png (5760x3240, PNG)",
      ],
    },
    {
      id: "job-b7c2",
      kind: "video",
      input: "D:\\Footage\\drone-coast-4k.mp4",
      output: "D:\\Footage\\drone-coast-4k-nr.mp4",
      engine: "nr",
      state: "running",
      progress: 0.42,
      message: "Frame 1210/2880",
      framesDone: 1210,
      framesTotal: 2880,
      fps: 23.6,
      createdAt: at(70),
      startedAt: at(65),
      finishedAt: null,
      error: null,
      log: [
        "[queue] video job accepted (engine=nr, motion=flow, scale=none)",
        "[ffmpeg] demux 3840x2160 @ 29.97 fps, 2880 frames, h264 -> rawvideo",
        "[ngx] D3D12 device ready on adapter 0, NVSDK_NGX_D3D12_CreateFeature(18) ok",
        "[nr] frame 600: evaluate ok (23.1 fps)",
        "[nr] frame 1200: evaluate ok (23.6 fps)",
      ],
    },
    {
      id: "job-c9d4",
      kind: "image",
      input: "C:\\Users\\tim\\Pictures\\portrait-raw.tif",
      output: null,
      engine: "nr",
      state: "failed",
      progress: 0,
      message: "Feature creation failed",
      framesDone: 0,
      framesTotal: 1,
      fps: null,
      createdAt: at(640),
      startedAt: at(639),
      finishedAt: at(638),
      error: "NVSDK_NGX_D3D12_CreateFeature(18) failed: NVSDK_NGX_Result_FAIL_OutOfDate (0xBAD00003) - driver 596.72 is below the 600.10 minimum",
      log: [
        "[queue] image job accepted (engine=nr, motion=none, scale=none)",
        "[ngx] NVSDK_NGX_D3D12_Init_Ext -> Success",
        "[ngx] NVSDK_NGX_D3D12_CreateFeature(18) -> NVSDK_NGX_Result_FAIL_OutOfDate (0xBAD00003)",
        "[job] failed",
      ],
    },
    {
      id: "job-d2e8",
      kind: "video",
      input: "D:\\Footage\\interview-1080p.mkv",
      output: null,
      engine: "bypass",
      state: "queued",
      progress: 0,
      message: "Queued behind 1 job",
      framesDone: 0,
      framesTotal: 1440,
      fps: null,
      createdAt: at(20),
      startedAt: null,
      finishedAt: null,
      error: null,
      log: ["[queue] video job accepted (engine=bypass, motion=none, scale=factor)"],
    },
    {
      id: "job-e5f1",
      kind: "image",
      input: "C:\\Users\\tim\\Pictures\\old-scan.jpg",
      output: null,
      engine: "nr",
      state: "cancelled",
      progress: 0.4,
      message: "Cancelled by user",
      framesDone: 0,
      framesTotal: 1,
      fps: null,
      createdAt: at(3300),
      startedAt: at(3299),
      finishedAt: at(3297),
      error: null,
      log: [
        "[queue] image job accepted (engine=nr, motion=none, scale=size)",
        "[nr] warm-up evaluation 2/4",
        "[job] cancelled by user",
      ],
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Structural check for a POST /api/jobs body (used by the mock server). */
export function isJobRequest(value: unknown): value is JobRequest {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "image" || value.kind === "video") &&
    typeof value.input === "string" &&
    (value.output === undefined || typeof value.output === "string") &&
    (value.engine === "bypass" || value.engine === "nr" || value.engine === "sr") &&
    (value.motion === "none" || value.motion === "flow") &&
    isRecord(value.settings) &&
    isRecord(value.scale)
  );
}

/** Rejects requests the real server would refuse before queueing. */
export function validateJobRequest(request: JobRequest): void {
  if (request.input.trim() === "") throw new ApiError(400, "input path is required");
  if (request.kind === "video" && !request.encode) throw new ApiError(400, "video jobs need encode settings");
}

function outputPathFor(request: JobRequest): string {
  const dot = request.input.lastIndexOf(".");
  const slash = Math.max(request.input.lastIndexOf("\\"), request.input.lastIndexOf("/"));
  const hasExtension = dot > slash;
  const stem = hasExtension ? request.input.slice(0, dot) : request.input;
  const extension =
    request.kind === "video" ? `.${request.encode?.container ?? "mp4"}` : hasExtension ? request.input.slice(dot) : ".png";
  return `${stem}-nr${extension}`;
}

function cloneJob(job: JobStatus): JobStatus {
  return { ...job, log: [...job.log] };
}

const MAX_MOCK_LOG = 200;
type Listener = (event: WsEvent) => void;
type Timer = ReturnType<typeof setTimeout>;

/** In-memory job queue that advances queued/running jobs on timers and publishes WsEvents. */
export class MockJobEngine {
  private readonly jobs = new Map<string, JobStatus>();
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Map<string, Timer>();
  private readonly tickMs: number;
  private counter = 0;

  constructor(seed: JobStatus[] = [], tickMs = 400) {
    this.tickMs = tickMs;
    for (const job of seed) this.jobs.set(job.id, cloneJob(job));
    for (const job of this.jobs.values()) {
      if (job.state === "running") this.schedule(job.id, tickMs);
      else if (job.state === "queued") this.schedule(job.id, 2500);
    }
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map(cloneJob);
  }

  get(id: string): JobStatus | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  create(request: JobRequest): JobStatus {
    this.counter += 1;
    const id = `job-${Date.now().toString(36)}${this.counter.toString(36)}`;
    const job: JobStatus = {
      id,
      kind: request.kind,
      input: request.input,
      output: request.output && request.output.trim() !== "" ? request.output : outputPathFor(request),
      engine: request.engine,
      state: "queued",
      progress: 0,
      message: "Queued",
      framesDone: 0,
      framesTotal: request.kind === "image" ? 1 : 240 + Math.floor(Math.random() * 600),
      fps: null,
      createdAt: timestamp(),
      startedAt: null,
      finishedAt: null,
      error: null,
      log: [
        `[queue] ${request.kind} job accepted (engine=${request.engine}, motion=${request.motion}, scale=${request.scale.mode})`,
      ],
    };
    this.jobs.set(id, job);
    this.emitJob(job);
    this.schedule(id, 700);
    return cloneJob(job);
  }

  cancel(id: string): JobStatus | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.state === "queued" || job.state === "running") {
      this.clearTimer(id);
      job.state = "cancelled";
      job.finishedAt = timestamp();
      job.message = "Cancelled by user";
      this.appendLog(job, "[job] cancelled by user");
      this.emitJob(job);
    }
    return cloneJob(job);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  private schedule(id: string, delay: number): void {
    this.clearTimer(id);
    this.timers.set(
      id,
      setTimeout(() => this.tick(id), delay),
    );
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private tick(id: string): void {
    this.timers.delete(id);
    const job = this.jobs.get(id);
    if (!job) return;

    if (job.state === "queued") {
      job.state = "running";
      job.startedAt = timestamp();
      job.message = "Creating NGX feature 18";
      this.appendLog(job, "[ngx] D3D12 device ready on adapter 0, NVSDK_NGX_D3D12_CreateFeature(18) ok");
      this.emitJob(job);
      this.schedule(id, this.tickMs);
      return;
    }
    if (job.state !== "running") return;

    const total = job.framesTotal ?? 1;
    if (job.kind === "image") {
      job.progress = Math.min(1, job.progress + 0.2);
      const warmup = Math.min(4, Math.round(job.progress * 5));
      job.message = `Warm-up evaluation ${warmup}/4`;
    } else {
      const step = Math.max(1, Math.round(total / 60 + Math.random() * 4));
      job.framesDone = Math.min(total, job.framesDone + step);
      job.progress = job.framesDone / total;
      job.fps = Math.round((21 + Math.random() * 5) * 10) / 10;
      job.message = `Frame ${job.framesDone}/${total}`;
      if (job.framesDone % 120 < step) this.emitLog(job, `[nr] frame ${job.framesDone}: evaluate ok (${job.fps} fps)`);
    }

    if (job.progress >= 1) {
      job.framesDone = total;
      job.progress = 1;
      job.state = "done";
      job.finishedAt = timestamp();
      job.message = "Done";
      this.appendLog(job, `[io] wrote ${job.output ?? "output"}`);
      this.emitJob(job);
      return;
    }
    this.emitJob(job);
    this.schedule(id, this.tickMs);
  }

  private appendLog(job: JobStatus, line: string): void {
    job.log.push(line);
    if (job.log.length > MAX_MOCK_LOG) job.log.splice(0, job.log.length - MAX_MOCK_LOG);
  }

  private emitLog(job: JobStatus, line: string): void {
    this.appendLog(job, line);
    this.emit({ type: "log", jobId: job.id, line });
  }

  private emitJob(job: JobStatus): void {
    this.emit({ type: "job", job: cloneJob(job) });
  }

  private emit(event: WsEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** A stand-in for /api/file: a generated landscape whose look depends on the path (outputs look "enhanced"). */
export function mockPreviewSvg(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const enhanced = /(-|_)nr\.|enhanced|output/i.test(name);
  let hash = 7;
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const saturation = enhanced ? 80 : 45;
  const lightness = enhanced ? 50 : 38;
  const blur = enhanced ? 0 : 1.6;
  const label = enhanced ? "mock preview - neural rendering" : "mock preview - source";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">` +
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} ${saturation}% ${lightness}%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 40) % 360} ${saturation}% ${lightness - 22}%)"/>` +
    `</linearGradient><filter id="soft"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>` +
    `<g filter="url(#soft)"><rect width="960" height="540" fill="url(#sky)"/>` +
    `<circle cx="700" cy="150" r="${enhanced ? 72 : 60}" fill="hsl(${(hue + 180) % 360} ${saturation}% 82%)" opacity="${enhanced ? 0.95 : 0.6}"/>` +
    `<path d="M0 400 L160 300 L300 380 L460 250 L620 360 L780 280 L960 380 L960 540 L0 540 Z" fill="hsl(${hue} ${saturation - 10}% ${enhanced ? 20 : 28}%)"/>` +
    `<path d="M0 470 L200 420 L380 460 L560 410 L760 450 L960 420 L960 540 L0 540 Z" fill="hsl(${(hue + 20) % 360} ${saturation - 15}% ${enhanced ? 12 : 20}%)"/></g>` +
    `<text x="24" y="40" font-family="Segoe UI, sans-serif" font-size="20" fill="#fff" opacity="0.75">${escapeXml(label)}</text>` +
    `<text x="24" y="512" font-family="Segoe UI, sans-serif" font-size="26" fill="#fff" opacity="0.9">${escapeXml(name)}</text>` +
    `</svg>`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Browser-side replacement for the HTTP client + WebSocket feed, driven by MockJobEngine timers. */
export function createMockBackend(): { client: ApiClient; events: JobEventSource } {
  const engine = new MockJobEngine(createSeedJobs());
  const client: ApiClient = {
    probe: async () => {
      await delay(1200);
      return { ...structuredClone(MOCK_PROBE), generatedAt: timestamp() };
    },
    runtime: async () => structuredClone(MOCK_PROBE.runtime),
    settingsDefaults: async () => mockSettingsDefaults(),
    tools: async () => structuredClone(MOCK_TOOLS),
    catalog: async () => ({
      features: [
        { id: 1, name: "DLSS Super Resolution", dllName: "nvngx_dlss.dll", versions: [
          { version: "310.7.0.0", path: "C:\\mock\\dlss\\nvngx_dlss.dll", sizeMB: 70.8, dir: "C:\\mock\\dlss", source: "runtime", sortKey: "0" },
          { version: "310.6.0.0", path: "C:\\mock\\swapper\\nvngx_dlss.dll", sizeMB: 70.1, dir: "C:\\mock\\swapper", source: "swapper", sortKey: "0" },
        ] },
        { id: 18, name: "DLSS Neural Rendering", dllName: "nvngx_dlssnr.dll", versions: [
          { version: "1.0.0.0", path: "C:\\mock\\dlssnr\\nvngx_dlssnr.dll", sizeMB: 158, dir: "C:\\mock\\dlssnr", source: "runtime", sortKey: "0" },
        ] },
      ],
    }),
    listJobs: async () => engine.list(),
    getJob: async (id) => {
      const job = engine.get(id);
      if (!job) throw new ApiError(404, `No job with id ${id}`);
      return job;
    },
    createJob: async (request) => {
      validateJobRequest(request);
      await delay(200);
      return engine.create(request);
    },
    cancelJob: async (id) => {
      const job = engine.cancel(id);
      if (!job) throw new ApiError(404, `No job with id ${id}`);
      return job;
    },
    uploadFile: async (file) => {
      await delay(150);
      return { path: `C:\\mock\\uploads\\${file.name}`, name: file.name, size: file.size };
    },
    fileUrl: (path) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mockPreviewSvg(path))}`,
  };
  const events: JobEventSource = {
    connect({ onEvent, onConnection }) {
      onConnection(true);
      onEvent({ type: "hello", serverTime: timestamp() });
      const unsubscribe = engine.subscribe(onEvent);
      return () => {
        unsubscribe();
        onConnection(false);
      };
    },
  };
  return { client, events };
}
