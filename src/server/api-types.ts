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

export type EngineKind = "bypass" | "nr";
export type MotionKind = "none" | "flow";
export type NrPath = "auto" | "core" | "snippet";

/** DLSS 5 Neural Rendering controls (NGX feature 18). Ranges follow what community tools expose. */
export interface NrSettings {
  /** Model hint 0..3 (0 = runtime default). */
  preset: 0 | 1 | 2 | 3;
  /** 0 = default, 1 = natural, 2 = cinematic. */
  style: 0 | 1 | 2;
  /** 0..2, 1 = neutral. */
  intensity: number;
  /** 0..2, 1 = neutral. */
  localTone: number;
  /** 0..2, 1 = neutral. */
  localStructure: number;
  /** -1..2, -1 = runtime default. */
  skinStructure: number;
  /** null = do not send the parameter. */
  globalTone: number | null;
  autoMask: boolean;
  uiCorrection: boolean;
  /** Which NGX entry to drive: the driver core or the runtime DLL directly. */
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
