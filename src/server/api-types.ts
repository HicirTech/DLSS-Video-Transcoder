/**
 * Shared contract between the Bun server (src/server) and the React UI (web/).
 *
 * HTTP endpoints (all JSON unless noted):
 *   GET  /api/probe                 -> ProbeReport      (runs the hardware / runtime probe in a process of its own, can take a few seconds;
 *                                                        500 { error } if that process fails or does not finish in time)
 *   GET  /api/runtime               -> ProbeReport["runtime"]  (reads the runtime folder only; no probe runs)
 *   GET  /api/settings/defaults     -> SettingsDefaults
 *   GET  /api/jobs                  -> JobStatus[]
 *   POST /api/jobs   body JobRequest -> JobStatus
 *   GET  /api/jobs/:id              -> JobStatus
 *   POST /api/jobs/:id/cancel       -> JobStatus
 *   GET  /api/file?path=<abs path>  -> raw file bytes (previews of inputs/outputs; local paths only)
 *   POST /api/upload?name=<file name>  body: the file's bytes -> UploadResult (streamed to disk, any size; the path is usable as a job input)
 *   GET  /api/tools                 -> ToolsReport      (ffmpeg / ffprobe availability)
 *   GET  /api/catalog               -> RuntimeManifest  (installed DLSS runtime DLL versions; see each step's dllDir)
 *   GET  /api/media?path=<abs path> -> MediaInfo        (size, rate and length of a file a job would read; 404 when it is not a file, 400 when it cannot be read)
 * WebSocket:
 *   /ws  server -> client messages are WsEvent JSON; the client never needs to send anything.
 */

// The accepted values for every constrained setting, in one place: the UI clamps
// to these and the API rejects outside them, so the two cannot drift apart. Each
// union below is derived from its array, and the order is the order menus and
// messages list the values in.
export const JOB_KINDS = ["image", "video"] as const;
type JobKind = (typeof JOB_KINDS)[number];
/** The processing steps a job can run, in the order they run: Super Resolution, Neural Rendering, frame generation. */
export const STEP_KINDS = ["sr", "nr", "fg"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const MOTION_KINDS = ["none", "flow"] as const;
export type MotionKind = (typeof MOTION_KINDS)[number];
export const NR_PRESETS = [0, 1, 2, 3] as const;
type NrPreset = (typeof NR_PRESETS)[number];
export const NR_STYLES = [0, 1, 2] as const;
type NrStyle = (typeof NR_STYLES)[number];
/** The words for each look style, shared by the CLI help and the web menu so both name them alike. */
export const NR_STYLE_LABELS: Record<NrStyle, string> = { 0: "Default", 1: "Natural", 2: "Cinematic" };
export const SCALE_MODES = ["none", "factor", "size"] as const;
type ScaleMode = (typeof SCALE_MODES)[number];
export const ENCODE_CODECS = ["h264", "hevc", "av1", "h264_nvenc", "hevc_nvenc", "av1_nvenc"] as const;
type EncodeCodec = (typeof ENCODE_CODECS)[number];
export const ENCODE_CONTAINERS = ["mp4", "mkv", "mov"] as const;
type EncodeContainer = (typeof ENCODE_CONTAINERS)[number];

/**
 * DLSS 5 Neural Rendering controls (NGX feature 18). Feature 18 enhances an image at the same
 * size (no upscale). These parameters are community-established (not in any public NVIDIA header).
 * SETTING_RANGES holds the strength ranges community tools expose. The DLL does not enforce them;
 * this program does: the CLI and validateJobRequest reject a value outside its range, and the UI
 * clamps to it.
 */
export interface NrSettings {
  /**
   * NR model preset hint (DLSSNR.Hint.Render.Preset): 0 = Default, 1/2/3 = Preset #1/#2/#3.
   * Distinct from the SR model preset J/K/L/M. Ignored by the installed runtime: see
   * NR_SETTINGS_IGNORED_BY_RUNTIME.
   */
  preset: NrPreset;
  /** Look style: 0 = Default, 1 = Natural, 2 = Cinematic. (Strong, visible effect.) */
  style: NrStyle;
  /** Overall neural-rendering strength, within SETTING_RANGES.intensity (default DEFAULT_NR_SETTINGS.intensity); the installed runtime stops responding at NR_INTENSITY_EFFECTIVE_MAX. */
  intensity: number;
  /** Local tone-mapping strength (float), within SETTING_RANGES.localTone; 1 = neutral. */
  localTone: number;
  /** Local detail / micro-structure strength (float), within SETTING_RANGES.localStructure; 1 = neutral. */
  localStructure: number;
  /** Skin detail strength (float), within SETTING_RANGES.skinStructure; -1 = runtime default. Skin regions only. Ignored by the installed runtime: see NR_SETTINGS_IGNORED_BY_RUNTIME. */
  skinStructure: number;
  /** Let the runtime derive the processed-region mask instead of processing the whole frame. */
  autoMask: boolean;
  /** Protect overlays / text / sharp UI edges from being re-rendered. Ignored by the installed runtime: see NR_SETTINGS_IGNORED_BY_RUNTIME. */
  uiCorrection: boolean;
}

export const DEFAULT_NR_SETTINGS: NrSettings = {
  preset: 0,
  style: 0,
  intensity: 1,
  localTone: 1,
  localStructure: 1,
  skinStructure: -1,
  autoMask: false,
  uiCorrection: false,
};

/** An image job's passes over its still before the kept one, so the temporal state of SR and NR settles (JobRequest.warmupFrames). */
export const DEFAULT_WARMUP_FRAMES = 4;

export interface ScaleSettings {
  /** none = keep source size, factor = multiply, size = explicit output size. */
  mode: ScaleMode;
  factor: number;
  width: number;
  height: number;
}

export const DEFAULT_SCALE_SETTINGS: ScaleSettings = { mode: "none", factor: 1.5, width: 1920, height: 1080 };

export interface EncodeSettings {
  codec: EncodeCodec;
  /** CRF / CQ style quality, lower is better. */
  quality: number;
  container: EncodeContainer;
  copyAudio: boolean;
}

/**
 * NVENC by default, so a job takes a GPU encode path; a job whose GPU cannot run NVENC falls back to the CPU
 * sibling with a note (resolveEncodeCodec). Quality 20 is CQ 20 for NVENC, CRF 20 after that fallback.
 */
export const DEFAULT_ENCODE_SETTINGS: EncodeSettings = { codec: "h264_nvenc", quality: 20, container: "mp4", copyAudio: true };

/**
 * The longest side, in pixels, each NVENC encoder takes; a larger output encodes with the codec's CPU sibling
 * instead (resolveEncodeCodec). Measured on an RTX 5090, NVENC API 13.1: NVENC reports NV_ENC_CAPS_WIDTH_MAX and
 * HEIGHT_MAX of 4096 for H.264, and ffmpeg encodes 4096x4096 with h264_nvenc but not 4098x2160, and 8192x8192
 * with hevc_nvenc and av1_nvenc but not 8208x4320.
 */
export const NVENC_MAX_SIDE: Readonly<Partial<Record<EncodeCodec, number>>> = { h264_nvenc: 4096, hevc_nvenc: 8192, av1_nvenc: 8192 };

/**
 * What a video job does with the source's audio track in each container: mkv takes the track as it is, mp4
 * and mov get it re-encoded to AAC at AAC_KBPS. audioArgs (ffmpeg-args.ts) builds the ffmpeg side of it.
 */
export const AUDIO_IN_CONTAINER: Record<EncodeContainer, "copy" | "aac"> = { mp4: "aac", mkv: "copy", mov: "aac" };

/** The bitrate, in kb/s, of the AAC track an mp4 or mov output carries. */
export const AAC_KBPS = 192;

/** The one container frame generation writes: its mux sets MP4's track timescale and +faststart (framegen-encode-sink.ts). */
export const FRAME_GEN_CONTAINER: EncodeContainer = "mp4";

/** Frame generation's output/source rate when neither a target rate nor a multiplier is given (2 = double the fps). */
export const DEFAULT_FRAME_GEN_MULTIPLIER = 2;

/**
 * DLSS Super Resolution only enlarges: an output side shorter than the source's fails CreateFeature with
 * InvalidParameter (factors 0.25, 0.5 and 0.75 measured), so an sr job's factor starts here; 1 runs DLAA.
 */
export const SR_FACTOR_MIN = 1;

/**
 * The longest output side DLSS SR creates a feature for: nvngx_dlss.dll 310.7.129.0
 * takes 5600x8192 and refuses 5600x8194 with InvalidParameter (measured on an RTX 5090).
 */
export const DLSS_SR_MAX_OUTPUT_SIDE = 8192;

/** Named frame-generation output rates, ascending; the pipeline's exact-rational FPS table uses the same names. */
export const FRAME_GEN_FPS_CHOICES = ["23.976", "25", "29.97", "30", "50", "59.94", "60", "90", "119.88", "120", "144", "165", "180", "240", "360", "480"] as const;
export type FrameGenFps = (typeof FRAME_GEN_FPS_CHOICES)[number];
/** Frame-generation path selection; see JobRequest.frameGen.engine. */
export const FRAME_GEN_ENGINES = ["auto", "native", "cascade"] as const;
export type FrameGenEngine = (typeof FRAME_GEN_ENGINES)[number];

/**
 * How far a native session reaches, in the words every surface that offers it uses. The runtime
 * reports MultiFrameCountMax; 6x was measured with tests/diag-dlssg.ts.
 */
export const FRAME_GEN_NATIVE_MAXIMUM = "the runtime's MultiFrameCountMax + 1, 6x with the bundled nvngx_dlssg.dll 310.7.129 on an RTX 5090";

/** Which GPU frame generation takes; a request cannot choose it (JobRequest.adapterUuid). */
export const FRAME_GEN_GPU_CHOICE = "the DLSS Frame Generation host process takes the NVIDIA GPU with CUDA and the most VRAM, and its NVENC and NVOFA helpers use CUDA device 0";

/**
 * Neural-rendering settings the installed runtime (NR_RUNTIME_MEASURED) accepts
 * but does not act on: measured with tests/diag-nr-settings.ts, every value of
 * each produces byte-identical output (intensity's own limit is
 * NR_INTENSITY_EFFECTIVE_MAX). They stay in the request shape because a later
 * DLL may honour them; every surface that offers them says what happens today,
 * through NR_IGNORED_NOTE.
 *
 * Re-run that diagnostic after a runtime update before changing this list.
 */
export const NR_SETTINGS_IGNORED_BY_RUNTIME = ["preset", "skinStructure", "uiCorrection"] as const;

/** The runtime the list above was measured against; named wherever the list is explained. */
export const NR_RUNTIME_MEASURED = "nvngx_dlssnr.dll 310.8.2.0";

/**
 * The one clause every surface (CLI help, web editor) uses for a setting in
 * NR_SETTINGS_IGNORED_BY_RUNTIME; subject-neutral so it reads after one control
 * or several.
 */
export const NR_IGNORED_NOTE = `ignored by the installed ${NR_RUNTIME_MEASURED}: every value gives the same image (measured with tests/diag-nr-settings.ts)`;

/** Whether the installed runtime acts on a setting; the UI disables the ones it does not. */
export function nrSettingIgnored(name: keyof NrSettings): boolean {
  return (NR_SETTINGS_IGNORED_BY_RUNTIME as readonly string[]).includes(name);
}

/** Where intensity stops making a difference on the runtime measured above. */
export const NR_INTENSITY_EFFECTIVE_MAX = 1;

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
  // 16 is as far as the frame-generation rate table reaches from a 30 fps source (480 fps).
  multiplier: { min: 1, max: 16, integer: true },
} as const;

/** `value` held inside the range of a numeric setting, rounded first when that setting only takes whole numbers. */
export function clampToRange(field: keyof typeof SETTING_RANGES, value: number): number {
  const { min, max, integer } = SETTING_RANGES[field];
  return Math.min(max, Math.max(min, integer ? Math.round(value) : value));
}

/** The Super Resolution step: DLSS SR upscales each frame to the output size. */
export interface SuperResolutionStep {
  /**
   * The output size: the source size (mode none, which runs DLAA), the source times a factor of at least
   * SR_FACTOR_MIN, or an exact size; each side rounded to even and at most DLSS_SR_MAX_OUTPUT_SIDE.
   */
  scale: ScaleSettings;
  /** Video only, default none: flow estimates optical flow between frames and hands SR the motion vectors. */
  motion?: MotionKind;
  /** Absolute folder of a DLSS Super Resolution version from GET /api/catalog; omit to load the bundled DLL. */
  dllDir?: string;
}

/** The Neural Rendering step: DLSS Neural Rendering (feature 18) enhances each frame at its size. */
export interface NeuralRenderingStep {
  settings: NrSettings;
  /** Absolute folder of a DLSS Neural Rendering version from GET /api/catalog; omit to load the bundled DLL. */
  dllDir?: string;
}

/**
 * The frame generation step, video only and last: DLSS Frame Generation interpolates the processed frames to a
 * higher rate. Give targetFps or multiplier (targetFps wins when both are present). The job writes
 * FRAME_GEN_CONTAINER, so encode.container and an explicit output's extension have to be that.
 */
export interface FrameGenStep {
  /** One of FRAME_GEN_FPS_CHOICES, or an exact "num/den" rate such as "60000/1001". */
  targetFps?: string;
  /** Output = source rate x multiplier (2 = double the fps), a whole number within SETTING_RANGES.multiplier. */
  multiplier?: number;
  /**
   * auto (default): one native DLSSG session when target/source is an exact integer from 2 up to
   * FRAME_GEN_NATIVE_MAXIMUM and, from 3x up, HAGS is on; otherwise a cascade of 2x stages. When
   * the runtime disables every interval of a native multi-frame session, auto re-runs the job as
   * a cascade. native / cascade force a path.
   */
  engine?: FrameGenEngine;
  /** Absolute folder of a DLSS Frame Generation version from GET /api/catalog; omit to load the bundled DLL. */
  dllDir?: string;
}

/**
 * A job: decode, then each step that is present, in the order of STEP_KINDS, then encode. A job with no step
 * re-encodes the source, resized when `resize` says so.
 */
export interface JobRequest {
  kind: JobKind;
  /** Absolute path on the machine running the server. */
  input: string;
  /** Absolute output path; omitted = next to the input, named after the steps that run (stepsSuffix), e.g. clip.sr-nr-fg.mp4. */
  output?: string;
  superResolution?: SuperResolutionStep;
  neuralRendering?: NeuralRenderingStep;
  frameGen?: FrameGenStep;
  /** A resize of the decoded frames, lanczos in a video's decode and bilinear for a still; Super Resolution sets the output size itself, so a job with it rejects this. */
  resize?: ScaleSettings;
  /** Video only; a video job without it encodes with DEFAULT_ENCODE_SETTINGS. */
  encode?: EncodeSettings;
  /** Image only: passes over the still before the kept one, for each of SR and NR; default DEFAULT_WARMUP_FRAMES. */
  warmupFrames?: number;
  /**
   * The GPU that Super Resolution and Neural Rendering run on, as the CUDA device UUID GET /api/probe lists
   * per adapter (ProbeAdapter.cudaUuid); omit for the automatic choice (the NVIDIA adapter with the most VRAM
   * that has a CUDA device). Frame generation picks its GPU in its host process (FRAME_GEN_GPU_CHOICE), so a
   * job that runs frame generation alone rejects this.
   */
  adapterUuid?: string;
}

/** The steps `request` runs, in their order. */
export function jobSteps(request: Pick<JobRequest, "superResolution" | "neuralRendering" | "frameGen">): StepKind[] {
  const present: Record<StepKind, boolean> = { sr: request.superResolution !== undefined, nr: request.neuralRendering !== undefined, fg: request.frameGen !== undefined };
  return STEP_KINDS.filter((step) => present[step]);
}

/**
 * What a job's default output is named after, between the input's stem and the extension: its steps in order
 * ("sr-nr-fg"), "resize" for a resize alone, "copy" for neither.
 */
export function stepsSuffix(steps: readonly StepKind[], resized: boolean): string {
  if (steps.length) return steps.join("-");
  return resized ? "resize" : "copy";
}

/** States in which a job still occupies the queue or the GPU, so a cancel can still reach it. */
const ACTIVE_JOB_STATES = ["queued", "running"] as const;
/** States a job never leaves. */
const TERMINAL_JOB_STATES = ["done", "failed", "cancelled"] as const;
export type JobState = (typeof ACTIVE_JOB_STATES)[number] | (typeof TERMINAL_JOB_STATES)[number];

export function isActiveState(state: JobState): boolean {
  return (ACTIVE_JOB_STATES as readonly JobState[]).includes(state);
}

export function isTerminalState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly JobState[]).includes(state);
}

/** JobStatus.message of a job that ended "cancelled". */
export const CANCELLED_MESSAGE = "cancelled by user";

/** Most recent log lines kept per job: the server trims to it and so does the web feed. */
export const JOB_LOG_LIMIT = 400;

/**
 * Whether a cancel was sent to a running job and what it did; kept after the
 * job ends. "pending": the job was asked to stop; it normally ends
 * "cancelled", but a failure that got there first still ends it "failed".
 * "too-late": the job had already started finishing its output, which it
 * completes. A queued job that is cancelled never ran, so it keeps "none".
 */
export type CancelRequest = "none" | "pending" | "too-late";

export interface JobStatus {
  id: string;
  kind: JobKind;
  input: string;
  output: string | null;
  /** The steps the job runs, in their order (jobSteps); empty for a plain re-encode. */
  steps: StepKind[];
  state: JobState;
  cancelRequest: CancelRequest;
  /** 0..1 */
  progress: number;
  message: string;
  /** Frames finished so far: encoded frames of a video, source frames processed by frame generation, engine passes over an image (its warm-up frames and the kept one). */
  framesDone: number;
  /** Frames expected; null when the source does not say. Frame generation's is an estimate, so framesDone can end past it. */
  framesTotal: number | null;
  /** framesDone per second since the job started, its start-up included; null until the first frame count arrives. */
  fps: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Most recent log lines, at most JOB_LOG_LIMIT. */
  log: string[];
}

/** What a Super Resolution step starts with on a form: 1.5x the source, no motion vectors. */
export const DEFAULT_SR_STEP: Required<Pick<SuperResolutionStep, "scale" | "motion">> = { scale: { ...DEFAULT_SCALE_SETTINGS, mode: "factor" }, motion: "none" };

/** What a frame generation step starts with on a form: 60 fps on the automatic path. */
export const DEFAULT_FRAME_GEN_STEP: Required<Pick<FrameGenStep, "targetFps" | "engine">> = { targetFps: "60", engine: "auto" };

/** Response of GET /api/media: what the server reads from a file before a job runs, so a form can show it and plan sizes. */
export type MediaInfo =
  | { kind: "image"; width: number; height: number }
  | {
      kind: "video";
      /** Display size, already turned for a 90/270 rotation: the size a job decodes. */
      width: number;
      height: number;
      /** The average rate a job decodes and stamps (VideoInfo.fpsText) and the nominal rate frame generation plans on. */
      fps: string;
      nominalFps: string;
      frames: number | null;
      durationSeconds: number | null;
      codec: string;
      hasAudio: boolean;
    };

/** Response of GET /api/settings/defaults: what each step and the output start with. */
export interface SettingsDefaults {
  superResolution: SuperResolutionStep;
  neuralRendering: NrSettings;
  frameGen: FrameGenStep;
  resize: ScaleSettings;
  encode: EncodeSettings;
  warmupFrames: number;
}

/** Response of POST /api/upload: where the server stored the file, and what the client sent. */
export interface UploadResult {
  path: string;
  name: string;
  size: number;
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
  /**
   * That CUDA device's UUID, as nvidia-smi prints it ("GPU-524e8373-..."); null
   * alongside a null ordinal. The stable name for a GPU: DXGI indices change
   * between runs and Windows reissues LUIDs at every boot, so this is what
   * JobRequest.adapterUuid stores.
   */
  cudaUuid: string | null;
  /** Whether a job would accept this adapter (NVIDIA hardware with a CUDA device), by the rule jobs apply. */
  eligible: boolean;
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

/**
 * How usable a feature is, from its NGX support bits: "outdated" when a newer driver or OS would make it work,
 * "blocked" when this GPU or driver cannot run it (or the query failed), "unknown" when nothing says either way.
 */
export type SupportLevel = "supported" | "outdated" | "blocked" | "unknown";

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

/**
 * Every way to make ffmpeg and ffprobe findable (src/pipeline/tools.ts looks for them in this order), in
 * the words the job errors and the web banner share. runtime/ffmpeg/bin is tools.ts's BUNDLED_FFMPEG_DIR.
 */
export const FFMPEG_SUPPLY_HINT = "set FFMPEG_PATH / FFPROBE_PATH in the environment, put both on PATH, place them in the project's runtime/ffmpeg/bin folder, or run `winget install Gyan.FFmpeg`";

export interface ToolsReport {
  ffmpeg: { path: string | null; version: string | null };
  ffprobe: { path: string | null; version: string | null };
  /** Whether this ffmpeg build lists the h264_nvenc encoder, not whether NVENC runs here: each job probes its own GPU (encode-select.ts). Null when there is no ffmpeg or it could not be asked. */
  nvenc: boolean | null;
}

export type WsEvent =
  | { type: "hello"; serverTime: string }
  | { type: "job"; job: JobStatus }
  | { type: "log"; jobId: string; line: string };
