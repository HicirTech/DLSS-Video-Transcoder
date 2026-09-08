/**
 * Shared contract between the Bun server (src/server) and the React UI (web/).
 *
 * HTTP endpoints (all JSON unless noted):
 *   GET  /api/probe                 -> ProbeReport      (runs the hardware / runtime probe, can take a few seconds)
 *   GET  /api/runtime               -> ProbeReport["runtime"]
 *   GET  /api/settings/defaults     -> { settings: NrSettings, scale: ScaleSettings, encode: EncodeSettings }
 *   GET  /api/jobs                  -> JobStatus[]
 *   POST /api/jobs   body JobRequest -> JobStatus
 *   GET  /api/jobs/:id              -> JobStatus
 *   POST /api/jobs/:id/cancel       -> JobStatus
 *   GET  /api/file?path=<abs path>  -> raw file bytes (previews of inputs/outputs; local paths only)
 *   GET  /api/tools                 -> ToolsReport      (ffmpeg / ffprobe availability)
 * WebSocket:
 *   /ws  server -> client messages are WsEvent JSON; the client never needs to send anything.
 */

export type EngineKind = "bypass" | "nr" | "sr";
export type MotionKind = "none" | "flow";
export type NrPath = "auto" | "core" | "snippet";

/**
 * DLSS 5 Neural Rendering controls (NGX feature 18). Feature 18 enhances an image at the same
 * size (no upscale). These parameters are community-established (not in any public NVIDIA header);
 * the strength ranges below are the typical ranges community tools expose and our sliders allow,
 * not hard limits enforced by the DLL.
 */
export interface NrSettings {
  /**
   * Neural model preset hint (DLSSNR.Hint.Render.Preset, i32): 0 = runtime default; 10/11/12/13 =
   * transformer models J/K/L/M. NOTE: verified to have no visible effect on the current runtime,
   * so the UI does not surface it; kept for forward compatibility.
   */
  preset: 0 | 10 | 11 | 12 | 13;
  /** Look style: 0 = default, 1 = natural, 2 = cinematic. (Verified to change the result.) */
  style: 0 | 1 | 2;
  /** Overall enhancement blend, 0..1 (0 = off / original, 1 = full). Values above 1 are clamped. */
  intensity: number;
  /** Local tone-mapping strength (float). Typical 0..2, 1 = neutral. */
  localTone: number;
  /** Local detail / micro-structure strength (float). Typical 0..2, 1 = neutral. */
  localStructure: number;
  /** Skin detail strength (float). Typical -1..2; -1 = runtime default. Affects skin regions only. */
  skinStructure: number;
  /** Global tone-mapping strength, or null. NOTE: not applied by the current runtime. */
  globalTone: number | null;
  /** Let the runtime derive the processed-region mask instead of processing the whole frame. */
  autoMask: boolean;
  /** Protect overlays / text / sharp UI edges from being re-rendered. */
  uiCorrection: boolean;
  /** Which NGX entry drives feature 18: the driver core, the standalone DLL ("snippet"), or auto. */
  nrPath: NrPath;
  /** Extra evaluations of the first frame so the temporal state settles (images use this). */
  warmupFrames: number;
}

export const DEFAULT_NR_SETTINGS: NrSettings = {
  preset: 0,
  style: 0,
  intensity: 1,
  localTone: 1,
  localStructure: 1,
  skinStructure: -1,
  globalTone: null,
  autoMask: false,
  uiCorrection: false,
  nrPath: "auto",
  warmupFrames: 4,
};

export interface ScaleSettings {
  /** none = keep source size, factor = multiply, size = explicit output size. */
  mode: "none" | "factor" | "size";
  factor: number;
  width: number;
  height: number;
}

export const DEFAULT_SCALE_SETTINGS: ScaleSettings = { mode: "none", factor: 1.5, width: 1920, height: 1080 };

export interface EncodeSettings {
  codec: "h264" | "hevc" | "av1" | "h264_nvenc" | "hevc_nvenc" | "av1_nvenc";
  /** CRF / CQ style quality, lower is better. */
  quality: number;
  container: "mp4" | "mkv" | "mov";
  copyAudio: boolean;
}

export const DEFAULT_ENCODE_SETTINGS: EncodeSettings = { codec: "h264", quality: 18, container: "mp4", copyAudio: true };

export interface JobRequest {
  kind: "image" | "video";
  /** Absolute path on the machine running the server. */
  input: string;
  /** Absolute output path; omitted = next to the input with a suffix. */
  output?: string;
  engine: EngineKind;
  motion: MotionKind;
  settings: NrSettings;
  scale: ScaleSettings;
  encode?: EncodeSettings;
  /**
   * Video only. When set, the job runs DLSS Frame Generation (interpolate to a
   * higher frame rate) instead of the per-frame engine; `multiplier` is the
   * output-to-input frame ratio (2 = double the fps). The per-frame engine and
   * scale settings are ignored in this mode.
   */
  frameGen?: { multiplier: number };
  /**
   * Absolute folder of a specific DLSS DLL version to load (from GET /api/catalog);
   * omit to use the bundled runtime DLL. Applies to the sr and nr engines.
   */
  dllDir?: string;
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobStatus {
  id: string;
  kind: "image" | "video";
  input: string;
  output: string | null;
  engine: EngineKind;
  state: JobState;
  /** 0..1 */
  progress: number;
  message: string;
  framesDone: number;
  framesTotal: number | null;
  fps: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Most recent log lines (bounded). */
  log: string[];
}

export interface ProbeAdapter {
  index: number;
  name: string;
  vendorId: number;
  deviceId: number;
  dedicatedVideoMemoryMB: number;
  luid: string;
  isNvidia: boolean;
  software: boolean;
}

export interface ProbeFeature {
  /** NGX feature id (1 = DLSS SR, 11 = frame generation, 13 = ray reconstruction, 18 = neural rendering). */
  id: number;
  name: string;
  /** Human readable support verdict, e.g. "supported", "driver too old", "adapter unsupported", "not implemented". */
  support: string;
  supportCode: number | null;
  minHwArchitecture: number | null;
  minOsVersion: string | null;
  detail: string;
}

export interface RuntimeFile {
  name: string;
  role: string;
  present: boolean;
  path: string | null;
  sizeMB: number | null;
  version: string | null;
  /** Export names found in the DLL, when present. */
  exports: string[] | null;
}

export interface ProbeReport {
  ok: boolean;
  generatedAt: string;
  platform: { os: string; bun: string };
  adapters: ProbeAdapter[];
  selectedAdapter: number | null;
  device: { created: boolean; hresult: string | null; featureLevel: string | null };
  driver: { version: string | null; ngxCorePath: string | null; ngxCoreVersion: string | null; ngxCoreExports: string[] };
  ngxInit: { attempted: boolean; result: string | null; ok: boolean };
  /** Capability parameters read from the NGX core, keyed by parameter name. */
  capabilities: Record<string, number | string | null>;
  features: ProbeFeature[];
  runtime: { folder: string; files: RuntimeFile[] };
  forwarder: { path: string | null; generated: boolean; loaded: boolean; selfTest: string | null };
  verdict: { neuralRenderingReady: boolean; reasons: string[] };
  log: string[];
}

export interface ToolsReport {
  ffmpeg: { path: string | null; version: string | null };
  ffprobe: { path: string | null; version: string | null };
  nvenc: boolean | null;
}

export type WsEvent =
  | { type: "hello"; serverTime: string }
  | { type: "job"; job: JobStatus }
  | { type: "log"; jobId: string; line: string };
