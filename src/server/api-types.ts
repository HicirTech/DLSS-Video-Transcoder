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
 *   POST /api/upload  multipart/form-data 'file' -> { path, name, size } (saved server-side; the path is usable as a job input)
 *   GET  /api/tools                 -> ToolsReport      (ffmpeg / ffprobe availability)
 *   GET  /api/catalog               -> RuntimeManifest  (installed DLSS runtime DLL versions; see JobRequest.dllDir)
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
   * NR model preset hint (DLSSNR.Hint.Render.Preset): 0 = Default, 1/2/3 = Preset #1/#2/#3.
   * Experimental and content-dependent (per the reference project) — Default is recommended and is
   * often the only one with a visible effect. Distinct from the SR model preset J/K/L/M.
   */
  preset: 0 | 1 | 2 | 3;
  /** Look style: 0 = Default, 1 = Natural, 2 = Cinematic. (Strong, visible effect.) */
  style: 0 | 1 | 2;
  /** Overall neural-rendering strength, 0..2 (1 = default; the effect tends to plateau past ~1). */
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

/** Named frame-generation output rates, ascending; the pipeline's exact-rational FPS table uses the same names. */
export const FRAME_GEN_FPS_CHOICES = ["23.976", "25", "29.97", "30", "50", "59.94", "60", "90", "119.88", "120", "144", "165", "180", "240", "360", "480"] as const;
export type FrameGenFps = (typeof FRAME_GEN_FPS_CHOICES)[number];
/** Frame-generation path selection; see JobRequest.frameGen.engine. */
export const FRAME_GEN_ENGINES = ["auto", "native", "cascade"] as const;
export type FrameGenEngine = (typeof FRAME_GEN_ENGINES)[number];

// The accepted values for every constrained setting, in one place: the UI clamps
// to these and the API rejects outside them, so the two cannot drift apart.
/**
 * Neural-rendering settings the installed runtime accepts but does not act on.
 * Measured with tests/diag-nr-settings.ts against nvngx_dlssnr.dll 310.8.2.0:
 * every value of these three produces byte-identical output, and intensity is
 * inert above 1.0. They stay in the request shape because a later DLL may
 * honour them; every surface that offers them says what happens today.
 *
 * Re-run that diagnostic after a runtime update before changing this list.
 */
export const NR_SETTINGS_IGNORED_BY_RUNTIME = ["preset", "skinStructure", "uiCorrection"] as const;

/** Where intensity stops making a difference on the runtime measured above. */
export const NR_INTENSITY_EFFECTIVE_MAX = 1;

export const NR_PRESETS = [0, 1, 2, 3] as const;
export const NR_STYLES = [0, 1, 2] as const;
export const NR_PATHS = ["auto", "core", "snippet"] as const;
export const SCALE_MODES = ["none", "factor", "size"] as const;
export const ENCODE_CODECS = ["h264", "hevc", "av1", "h264_nvenc", "hevc_nvenc", "av1_nvenc"] as const;
export const ENCODE_CONTAINERS = ["mp4", "mkv", "mov"] as const;

/** Inclusive `[min, max]` for each numeric setting; `integer` fields reject fractions. */
export const SETTING_RANGES = {
  intensity: { min: 0, max: 2, integer: false },
  localTone: { min: 0, max: 2, integer: false },
  localStructure: { min: 0, max: 2, integer: false },
  skinStructure: { min: -1, max: 2, integer: false },
  warmupFrames: { min: 0, max: 64, integer: true },
  factor: { min: 0.25, max: 8, integer: false },
  width: { min: 16, max: 16384, integer: true },
  height: { min: 16, max: 16384, integer: true },
  quality: { min: 0, max: 51, integer: true },
} as const;

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
   * higher frame rate) instead of the per-frame engine. The per-frame engine and
   * scale settings are ignored in this mode. Give either `targetFps` or
   * `multiplier` (targetFps wins when both are present).
   */
  frameGen?: {
    /** One of FRAME_GEN_FPS_CHOICES, or an exact "num/den" rate such as "60000/1001". */
    targetFps?: string;
    /** Convenience ratio when targetFps is absent: output = source rate x multiplier (2 = double the fps). */
    multiplier?: number;
    /**
     * auto (default): native multi-frame DLSSG when target/source is an exact integer the
     * runtime supports and HAGS is on, otherwise a cascade of 2x stages. The bundled
     * dlssg-worker only ever synthesises one frame per interval — even with HAGS on — so
     * auto falls back to the cascade on its own. native / cascade force a path.
     */
    engine?: FrameGenEngine;
  };
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
  /**
   * CUDA device ordinal whose LUID matches this adapter's; null when CUDA lists
   * no device with this LUID, or when CUDA could not be queried at all (see
   * ProbeReport.cuda.error). Jobs run only on an adapter with one.
   */
  cudaOrdinal: number | null;
}

/** The CUDA driver's side of the adapter list. */
export interface ProbeCuda {
  /** Devices the driver lists; null when it could not be asked. */
  deviceCount: number | null;
  /** Why it could not be asked (nvcuda.dll missing, cuInit failed); null when it answered. */
  error: string | null;
}

/** Input frame size NVOFA accepts, in pixels. */
export interface OpticalFlowLimits {
  widthMin: number;
  widthMax: number;
  heightMin: number;
  heightMax: number;
}

/** NVIDIA hardware optical flow (NVOFA) on the selected adapter's CUDA device. */
export interface ProbeOpticalFlow {
  /** "not queried" when the selected adapter has no CUDA device to ask on. */
  status: "ok" | "unavailable" | "not queried";
  /** "ok", or why the engine could not be brought up or was not asked. */
  detail: string;
  /** CUDA device the query ran on; null when status is "not queried". */
  cudaOrdinal: number | null;
  /** Null unless status is "ok". */
  limits: OpticalFlowLimits | null;
  /** Output grid sizes (one flow vector per NxN block) the engine offers; null unless status is "ok". The pipeline uses 1. */
  outGridSizes: number[] | null;
  /** The grid the pipeline actually feeds the engine: every side is at least minSide and the longer side at most maxLongSide pixels. */
  pipelineGrid: { minSide: number; maxLongSide: number };
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
  cuda: ProbeCuda;
  opticalFlow: ProbeOpticalFlow;
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
