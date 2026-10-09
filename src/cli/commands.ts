/**
 * The CLI's command table, the single source of truth: it renders the help *and* tells the
 * positional-argument parser which flags consume a following value token.
 */
import { DEFAULT_SR_PRESET, DLSS_RATIO, DLSS_SR_MAX_OUTPUT_SIDE, perfQualityName } from "../ngx/results.ts";
import { cpuSiblingCodec, FFMPEG_NVENC_ENCODERS, isNvenc } from "../pipeline/encode-select.ts";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_FRAME_GEN_MULTIPLIER, DEFAULT_NR_SETTINGS, ENCODE_CODECS, FRAME_GEN_FPS_CHOICES, FRAME_GEN_NATIVE_MAXIMUM, NR_IGNORED_NOTE, NR_INTENSITY_EFFECTIVE_MAX, NR_PRESETS, NR_RUNTIME_MEASURED, NR_STYLE_LABELS, NR_STYLES, SETTING_RANGES } from "../server/api-types.ts";

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

/** `sr --factor`: from 1, since DLSS SR only enlarges, up to the API's SETTING_RANGES.factor; and the factor used when it is absent. */
export const SR_FACTOR_OPTION = { min: 1, max: SETTING_RANGES.factor.max, fallback: 2 } as const;

/** `sr` / `nr --warmup`: the extra passes an image job runs over a still, with the job's range and default. */
export const WARMUP_OPTION = { ...SETTING_RANGES.warmupFrames, fallback: DEFAULT_NR_SETTINGS.warmupFrames } as const;
const WARMUP_OPT: OptionSpec = { flag: "--warmup N", desc: `extra passes over the same image so the temporal state settles, as an image job runs them, ${settingRange("warmupFrames")}`, def: String(WARMUP_OPTION.fallback) };

/** `fg --multiplier`: the range the API validates frameGen.multiplier against, and the multiplier used when it is absent. */
export const FG_MULTIPLIER_OPTION = { ...SETTING_RANGES.multiplier, fallback: DEFAULT_FRAME_GEN_MULTIPLIER } as const;

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
    notes: ["Exits 0 only when neural rendering is ready. Super Resolution and frame generation get no verdict: the report lists their DLL and what the driver says, and frame generation is checked when an fg job starts."],
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
    options: [
      { flag: "--intensity F", desc: `overall strength, ${settingRange("intensity")}; the installed ${NR_RUNTIME_MEASURED} stops responding above ${NR_INTENSITY_EFFECTIVE_MAX}, so every value from there up gives the same image`, def: String(DEFAULT_NR_SETTINGS.intensity) },
      { flag: "--style N", desc: `look style: ${NR_STYLES.map((style) => `${style} = ${NR_STYLE_LABELS[style]}`).join(", ")} (strong, visible effect)`, def: String(DEFAULT_NR_SETTINGS.style) },
      { flag: "--preset ID", desc: `NR model preset hint ${NR_PRESETS[0]}..${NR_PRESETS.at(-1)}; ${NR_IGNORED_NOTE}`, def: String(DEFAULT_NR_SETTINGS.preset) },
      { flag: "--local-tone F", desc: `local tone-mapping strength (float), ${settingRange("localTone")}; 1 = neutral`, def: String(DEFAULT_NR_SETTINGS.localTone) },
      { flag: "--local-structure F", desc: `local detail / structure strength (float), ${settingRange("localStructure")}; 1 = neutral`, def: String(DEFAULT_NR_SETTINGS.localStructure) },
      { flag: "--skin-structure F", desc: `detail strength on skin regions (float), ${settingRange("skinStructure")}; ${DEFAULT_NR_SETTINGS.skinStructure} = runtime default; ${NR_IGNORED_NOTE}`, def: String(DEFAULT_NR_SETTINGS.skinStructure) },
      { flag: "--auto-mask", desc: "let the runtime derive the processed-region mask instead of the whole frame", def: "off" },
      { flag: "--ui-correction", desc: `protect overlays / text / sharp UI edges from being re-rendered; ${NR_IGNORED_NOTE}`, def: "off" },
      WARMUP_OPT,
      RUNTIME_OPT,
      ADAPTER_OPT,
    ],
  },
  {
    name: "fg",
    summary: "DLSS Frame Generation (NGX feature 11): interpolate a video to a higher frame rate.",
    usage: "bun run src/cli.ts fg <input.mp4> [output.mp4] [options]",
    args: [
      { name: "input.mp4", desc: "source video (any format ffmpeg can decode)" },
      { name: "output.mp4", desc: "destination; defaults to <input>.dlssg.mp4 next to the input" },
    ],
    options: [
      { flag: "--fps RATE", desc: `output frame rate: ${FRAME_GEN_FPS_CHOICES.join(", ")}, or an exact num/den; overrides --multiplier`, def: "source fps x --multiplier" },
      { flag: "--multiplier N", desc: `output/input frame ratio when --fps is not given, a whole number from ${FG_MULTIPLIER_OPTION.min} to ${FG_MULTIPLIER_OPTION.max} (2 = double fps)`, def: String(FG_MULTIPLIER_OPTION.fallback) },
      { flag: "--engine MODE", desc: `auto = one native session when output/source is an exact integer from 2 up to ${FRAME_GEN_NATIVE_MAXIMUM} (3x and above only with HAGS on), else a cascade of 2x stages; when the runtime disables every interval of a native 3x+ session, auto re-runs it as a cascade; native or cascade force that path`, def: "auto" },
      { flag: "--codec NAME", desc: `encoder: ${ENCODE_CODECS.filter((codec) => !isNvenc(codec)).join(", ")}, or ${FFMPEG_NVENC_ENCODERS.join("/")} for GPU`, def: `${DEFAULT_ENCODE_SETTINGS.codec}, or ${cpuSiblingCodec(DEFAULT_ENCODE_SETTINGS.codec)} when NVENC cannot start` },
      { flag: "--quality N", desc: `encoder quality (CRF for CPU, CQ for NVENC), ${settingRange("quality")} (lower = better)`, def: String(DEFAULT_ENCODE_SETTINGS.quality) },
      RUNTIME_OPT,
    ],
    notes: ["A target at or below the source frame rate (--multiplier 1, or a lower --fps) generates no frames: the video is only resampled to it."],
  },
  {
    name: "versions",
    summary: "List every DLSS runtime DLL found (per feature), with its version, source and folder.",
    usage: "bun run src/cli.ts versions [--runtime DIR]",
    options: [RUNTIME_OPT],
    notes: ["Use a listed SR version string with `sr --dlss-version`."],
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

/** The table entry of a command whose name is known to be in COMMANDS. */
export function commandSpec(name: string): CommandSpec {
  return COMMANDS.find((c) => c.name === name)!;
}
