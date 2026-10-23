/**
 * The CLI's command table, the single source of truth: it renders the help *and* tells the
 * positional-argument parser which flags consume a following value token.
 */
import { DEFAULT_SR_PRESET, DLSS_RATIO, perfQualityName } from "../ngx/results.ts";
import { cpuSiblingCodec, FFMPEG_NVENC_ENCODERS, isNvenc } from "../pipeline/encode-select.ts";
import { AAC_KBPS, AUDIO_IN_CONTAINER, AUTO_GPU_CHOICE, DEFAULT_ENCODE_SETTINGS, DEFAULT_FRAME_GEN_MULTIPLIER, DEFAULT_NR_SETTINGS, DEFAULT_SR_STEP, DEFAULT_WARMUP_FRAMES, DLSS_SR_MAX_OUTPUT_SIDE, ENCODE_CODECS, ENCODE_CONTAINERS, FRAME_GEN_AUTO_PATH, FRAME_GEN_CONTAINER, FRAME_GEN_FPS_CHOICES, FRAME_GEN_GPU_CHOICE, MOTION_KINDS, NR_IGNORED_NOTE, NR_INTENSITY_EFFECTIVE_MAX, NR_PRESETS, NR_RUNTIME_MEASURED, NR_STYLE_LABELS, NR_STYLES, NVENC_MAX_SIDE, SETTING_RANGES, SR_FACTOR_MIN, type StepKind } from "../server/api-types.ts";

interface OptionSpec {
  /** As typed on the command line, e.g. "--factor N" or "--json". */
  readonly flag: string;
  readonly desc: string;
  readonly def?: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly args?: readonly { readonly name: string; readonly desc: string }[];
  readonly options: readonly OptionSpec[];
  readonly notes?: readonly string[];
}

/** "0..2": a numeric setting's inclusive range, printed from the SETTING_RANGES entry the CLI and the API both check against. */
function settingRange(field: keyof typeof SETTING_RANGES): string {
  const { min, max } = SETTING_RANGES[field];
  return `${min}..${max}`;
}

/** `sr --factor`: from SR_FACTOR_MIN, since DLSS SR only enlarges, up to the API's SETTING_RANGES.factor; and the factor used when it is absent. */
export const SR_FACTOR_OPTION = { min: SR_FACTOR_MIN, max: SETTING_RANGES.factor.max, fallback: 2 } as const;

/** `sr` / `nr --warmup`: the extra passes an image job runs over a still, with the job's range and default. */
export const WARMUP_OPTION = { ...SETTING_RANGES.warmupFrames, fallback: DEFAULT_WARMUP_FRAMES } as const;
const WARMUP_OPT: OptionSpec = { flag: "--warmup N", desc: `extra passes over the same image so the temporal state settles, as an image job runs them, ${settingRange("warmupFrames")}`, def: String(WARMUP_OPTION.fallback) };

/** `fg --multiplier`: the range the API validates frameGen.multiplier against, and the multiplier used when it is absent. */
export const FG_MULTIPLIER_OPTION = { ...SETTING_RANGES.multiplier, fallback: DEFAULT_FRAME_GEN_MULTIPLIER } as const;

/** `--quality`: the range the API validates encode.quality against, and the quality a job without encode settings gets. */
export const QUALITY_OPTION = { ...SETTING_RANGES.quality, fallback: DEFAULT_ENCODE_SETTINGS.quality } as const;

/** The encode rows, printed with the defaults a job without encode settings gets. */
const CODEC_OPT: OptionSpec = {
  flag: "--codec NAME",
  desc: `encoder: ${ENCODE_CODECS.filter((codec) => !isNvenc(codec)).join(", ")}, or ${FFMPEG_NVENC_ENCODERS.join("/")} for GPU, which take at most ${FFMPEG_NVENC_ENCODERS.map((codec) => `${NVENC_MAX_SIDE[codec]} (${codec})`).join(", ")} pixels per side; a larger output encodes with the CPU codec of the same format`,
  def: `${DEFAULT_ENCODE_SETTINGS.codec}, or ${cpuSiblingCodec(DEFAULT_ENCODE_SETTINGS.codec)} when NVENC cannot start or the output is larger`,
};
const QUALITY_OPT: OptionSpec = { flag: "--quality N", desc: `encoder quality (CRF for CPU, CQ for NVENC), ${settingRange("quality")} (lower = better)`, def: String(QUALITY_OPTION.fallback) };

/** The frame generation rows fg and video share; fg calls the path option --engine, video --fg-path. */
const FG_FPS_OPT: OptionSpec = { flag: "--fps RATE", desc: `output frame rate: ${FRAME_GEN_FPS_CHOICES.join(", ")}, or an exact num/den; overrides --multiplier`, def: "source fps x --multiplier" };
const FG_MULTIPLIER_OPT: OptionSpec = { flag: "--multiplier N", desc: `output/input frame ratio when --fps is not given, a whole number from ${FG_MULTIPLIER_OPTION.min} to ${FG_MULTIPLIER_OPTION.max} (2 = double fps)`, def: String(FG_MULTIPLIER_OPTION.fallback) };
const FG_PATH_DESC = `auto = ${FRAME_GEN_AUTO_PATH}; native or cascade force that path`;

/** The Neural Rendering look rows nr and video share; nrSettingsOption reads them, and video refuses them without --nr. */
export const NR_SETTING_OPTS: readonly OptionSpec[] = [
  { flag: "--intensity F", desc: `overall strength, ${settingRange("intensity")}; the installed ${NR_RUNTIME_MEASURED} stops responding above ${NR_INTENSITY_EFFECTIVE_MAX}, so every value from there up gives the same image`, def: String(DEFAULT_NR_SETTINGS.intensity) },
  { flag: "--style N", desc: `look style: ${NR_STYLES.map((style) => `${style} = ${NR_STYLE_LABELS[style]}`).join(", ")} (strong, visible effect)`, def: String(DEFAULT_NR_SETTINGS.style) },
  { flag: "--preset ID", desc: `NR model preset hint ${NR_PRESETS[0]}..${NR_PRESETS.at(-1)}; ${NR_IGNORED_NOTE}`, def: String(DEFAULT_NR_SETTINGS.preset) },
  { flag: "--local-tone F", desc: `local tone-mapping strength (float), ${settingRange("localTone")}; 1 = neutral`, def: String(DEFAULT_NR_SETTINGS.localTone) },
  { flag: "--local-structure F", desc: `local detail / structure strength (float), ${settingRange("localStructure")}; 1 = neutral`, def: String(DEFAULT_NR_SETTINGS.localStructure) },
  { flag: "--skin-structure F", desc: `detail strength on skin regions (float), ${settingRange("skinStructure")}; ${DEFAULT_NR_SETTINGS.skinStructure} = runtime default; ${NR_IGNORED_NOTE}`, def: String(DEFAULT_NR_SETTINGS.skinStructure) },
  { flag: "--auto-mask", desc: "let the runtime derive the processed-region mask instead of the whole frame", def: "off" },
  { flag: "--ui-correction", desc: `protect overlays / text / sharp UI edges from being re-rendered; ${NR_IGNORED_NOTE}`, def: "off" },
];

/** `video`'s per-step version row: a specific installed DLL of the step's feature, as `versions` lists them. */
function stepVersionOpt(step: StepKind, feature: string): OptionSpec {
  return { flag: `--${step}-version VER`, desc: `load a specific installed ${feature} DLL version (prefix match ok); list them with \`versions\``, def: "bundled runtime DLL" };
}

/** The `video` options that configure one step, which the command refuses unless that step's switch is given. */
export const VIDEO_STEP_OPTS: Record<StepKind, readonly OptionSpec[]> = {
  sr: [
    { flag: "--motion MODE", desc: `Super Resolution's motion vectors: ${MOTION_KINDS.join(" or ")}; flow estimates optical flow between frames, with NVIDIA's NVOFA when it starts and a CPU estimator otherwise`, def: DEFAULT_SR_STEP.motion },
    stepVersionOpt("sr", "DLSS Super Resolution"),
  ],
  nr: [...NR_SETTING_OPTS, stepVersionOpt("nr", "DLSS Neural Rendering")],
  fg: [FG_FPS_OPT, FG_MULTIPLIER_OPT, { flag: "--fg-path MODE", desc: FG_PATH_DESC, def: "auto" }, stepVersionOpt("fg", "DLSS Frame Generation")],
};

export const RUNTIME_OPT: OptionSpec = { flag: "--runtime DIR", desc: "runtime folder holding the NGX DLLs", def: "<repo>/runtime" };
export const ADAPTER_OPT: OptionSpec = { flag: "--adapter N", desc: "GPU adapter index as `probe` listed it in this session (DXGI indices can change between runs); the adapter must have a CUDA device. auto = the NVIDIA adapter with the most VRAM that has one", def: "auto" };

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "probe",
    summary: "Inspect the GPU, driver, NGX core and runtime folder; report whether neural rendering is ready.",
    usage: "bun run src/cli.ts probe [options]",
    options: [
      { flag: "--json", desc: "print the full report as JSON instead of the human summary" },
      { flag: "--log", desc: "append the internal probe log lines to the output" },
      ADAPTER_OPT,
      RUNTIME_OPT,
      { flag: "--entry loader|core", desc: "NGX entry point to initialise through", def: "core" },
      { flag: "--init ext|plain|spy", desc: "which NGX Init variant to call", def: "ext" },
      { flag: "--project-init", desc: "use the project-scoped Init (app id + project path) instead of the app Init" },
      { flag: "--null-feature-info", desc: "pass a null FeatureCommonInfo to Init (diagnostic)" },
      { flag: "--no-requirements", desc: "skip the per-feature GetFeatureRequirements queries" },
      { flag: "--debug-layer", desc: "enable the D3D12 debug layer (needs the Graphics Tools installed)" },
    ],
    notes: ["Exits 0 only when neural rendering is ready. Super Resolution and frame generation get no verdict: the report lists their DLL and what the driver says, and frame generation is checked when a job that runs it starts."],
  },
  {
    name: "forwarder",
    summary: "Generate the x64 `nvngx.dll` shim that makes NGX accept our in-process calls (caller-module check).",
    usage: "bun run src/cli.ts forwarder [--out PATH]",
    options: [
      { flag: "--out PATH", desc: "where to write the generated shim DLL", def: "<repo>/runtime/caller/nvngx.dll" },
    ],
    notes: ["Only needed to (re)build the shim by hand; sr/nr build it automatically when missing."],
  },
  {
    name: "sr",
    summary: "DLSS Super Resolution (NGX feature 1): real upscaling of a single PNG. This is the only true upscaler.",
    usage: "bun run src/cli.ts sr <input.png> [output.png] [options]",
    args: [
      { name: "input.png", desc: "source image (PNG only)" },
      { name: "output.png", desc: "destination; defaults to <input>.sr.png next to the input, the name an image job gives it" },
    ],
    options: [
      { flag: "--factor N", desc: `upscale factor ${SR_FACTOR_OPTION.min}..${SR_FACTOR_OPTION.max}: the output is the source size times N, each side rounded to even, as in an image job, and at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side; DLSS runs in the mode whose ratio is nearest (${srModeList()}), and 1 runs DLAA`, def: String(SR_FACTOR_OPTION.fallback) },
      WARMUP_OPT,
      { flag: "--preset NAME", desc: "render preset: Default, A-F or J-O; the installed nvngx_dlss.dll decides which model each selects", def: DEFAULT_SR_PRESET },
      { flag: "--dlss-version VER", desc: "use a specific installed SR DLL version (prefix match ok); list them with `versions`", def: "bundled runtime DLL" },
      RUNTIME_OPT,
      ADAPTER_OPT,
    ],
  },
  {
    name: "nr",
    summary: "DLSS Neural Rendering / 'DLSS 5' (NGX feature 18): enhance a single PNG at the same size (no upscale).",
    usage: "bun run src/cli.ts nr <input.png> [output.png] [options]",
    args: [
      { name: "input.png", desc: "source image (PNG only)" },
      { name: "output.png", desc: "destination; defaults to <input>.nr.png next to the input" },
    ],
    options: [...NR_SETTING_OPTS, WARMUP_OPT, RUNTIME_OPT, ADAPTER_OPT],
  },
  {
    name: "video",
    summary: "Any of DLSS Super Resolution, DLSS Neural Rendering and DLSS Frame Generation on a video in one pass, in that order, then encode: the video job the web UI runs.",
    usage: "bun run src/cli.ts video <input> [output] [--sr] [--nr] [--fg] [options]",
    args: [
      { name: "input", desc: "source video (any format ffmpeg can decode)" },
      { name: "output", desc: `destination, ending in the --container's extension (.${FRAME_GEN_CONTAINER} with --fg); defaults to <input>.<steps>.<container> next to the input, e.g. clip.sr-nr-fg.mp4, the name a video job gives it` },
    ],
    options: [
      { flag: "--sr", desc: `run DLSS Super Resolution: upscale every frame from the source size to the output size (--factor or --size), at least the source size (a factor of ${SR_FACTOR_OPTION.min} runs DLAA) and at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side`, def: "off" },
      { flag: "--nr", desc: "run DLSS Neural Rendering: enhance every frame at the output size, after Super Resolution when both run", def: "off" },
      { flag: "--fg", desc: `run DLSS Frame Generation last: interpolate the processed frames to --fps, or the source rate x --multiplier; writes ${FRAME_GEN_CONTAINER} only`, def: "off" },
      { flag: "--factor N", desc: `output size = the source size times N, each side rounded to even: with --sr, Super Resolution upscales to it, N ${SR_FACTOR_OPTION.min}..${SR_FACTOR_OPTION.max} and at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side; without it, the decode resizes to it with lanczos, N ${settingRange("factor")}`, def: `${DEFAULT_SR_STEP.scale.factor} with --sr, else the source size` },
      { flag: "--size WxH", desc: `output size in pixels instead of --factor, e.g. 3840x2160: width ${settingRange("width")}, height ${settingRange("height")}, each rounded to even; with --sr, each side at least the source's and at most ${DLSS_SR_MAX_OUTPUT_SIDE}`, def: `${DEFAULT_SR_STEP.scale.factor}x the source with --sr, else the source size` },
      ...VIDEO_STEP_OPTS.sr,
      ...VIDEO_STEP_OPTS.nr,
      ...VIDEO_STEP_OPTS.fg,
      CODEC_OPT,
      QUALITY_OPT,
      { flag: "--container NAME", desc: `output container: ${ENCODE_CONTAINERS.join(", ")}; --fg writes ${FRAME_GEN_CONTAINER} only`, def: DEFAULT_ENCODE_SETTINGS.container },
      { flag: "--no-audio", desc: `write no audio track; otherwise the source's audio is copied into ${containersThatAudio("copy")}, or re-encoded to AAC ${AAC_KBPS} kb/s for ${containersThatAudio("aac")}`, def: "off" },
      RUNTIME_OPT,
      { ...ADAPTER_OPT, desc: `${ADAPTER_OPT.desc}. Picks the GPU for --sr and --nr, or for the copy a job without steps runs; frame generation's host picks its own, so --fg alone refuses it` },
    ],
    notes: [
      "The steps run in the order Super Resolution, Neural Rendering, frame generation, whatever order the switches come in. With none of them, the video is only re-encoded, resized when --factor or --size is given.",
      `A step's options apply only with its switch: --motion and --sr-version with --sr; --intensity to --ui-correction and --nr-version with --nr; --fps, --multiplier, --fg-path and --fg-version with --fg. --preset is Neural Rendering's model preset hint: Super Resolution runs render preset ${DEFAULT_SR_PRESET}, as every Super Resolution job does.`,
      `Frame generation's GPU: ${FRAME_GEN_GPU_CHOICE}.`,
      "The command line becomes a POST /api/jobs request and passes the same request validation before the GPU opens.",
    ],
  },
  {
    name: "fg",
    summary: "DLSS Frame Generation (NGX feature 11): interpolate a video to a higher frame rate.",
    usage: "bun run src/cli.ts fg <input.mp4> [output.mp4] [options]",
    args: [
      { name: "input.mp4", desc: "source video (any format ffmpeg can decode)" },
      { name: "output.mp4", desc: "destination; defaults to <input>.fg.mp4 next to the input, the name a video job with frame generation alone gives it" },
    ],
    options: [
      FG_FPS_OPT,
      FG_MULTIPLIER_OPT,
      { flag: "--engine MODE", desc: FG_PATH_DESC, def: "auto" },
      CODEC_OPT,
      QUALITY_OPT,
      { flag: "--dlss-version VER", desc: "use a specific installed DLSS Frame Generation DLL version (prefix match ok); list them with `versions`", def: "bundled runtime DLL" },
      RUNTIME_OPT,
    ],
    notes: ["A target at or below the source frame rate (--multiplier 1, or a lower --fps) generates no frames: the video is only resampled to it."],
  },
  {
    name: "versions",
    summary: "List every DLSS runtime DLL found (per feature), with its version, source and folder.",
    usage: "bun run src/cli.ts versions [--runtime DIR]",
    options: [RUNTIME_OPT],
    notes: ["Use a listed version string with `sr --dlss-version` or `fg --dlss-version` for that feature, and with `video --sr-version`, `--nr-version` or `--fg-version` for each step."],
  },
  {
    name: "help",
    summary: "Show this overview, or detailed help for one command.",
    usage: "bun run src/cli.ts help [command]",
    options: [],
  },
];

/**
 * "1.00=DLAA, 1.50=MaxQuality, 1.72=Balanced, 2.00=MaxPerf, 3.00=UltraPerformance": the --factor help
 * and the sr summary must name the same modes, so both read DLSS_RATIO.
 */
function srModeList(): string {
  return Object.entries(DLSS_RATIO)
    .sort((a, b) => a[1] - b[1])
    .map(([quality, ratio]) => `${ratio.toFixed(2)}=${perfQualityName(Number(quality))}`)
    .join(", ");
}

/** "mp4 and mov": the containers whose audio track a video job handles as `handling` (AUDIO_IN_CONTAINER). */
function containersThatAudio(handling: "copy" | "aac"): string {
  return ENCODE_CONTAINERS.filter((container) => AUDIO_IN_CONTAINER[container] === handling).join(" and ");
}

/** The table entry of a command whose name is known to be in COMMANDS. */
export function commandSpec(name: string): CommandSpec {
  return COMMANDS.find((c) => c.name === name)!;
}
