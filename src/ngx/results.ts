/**
 * NGX result codes, feature ids and support bit flags, from the public
 * nvsdk_ngx_defs.h in NVIDIA's DLSS SDK, and the values every NGX init here passes.
 */
import { hex32 } from "../native/memory.ts";

export const NGX_SUCCESS = 0x1;

const RESULT_NAMES: Record<number, string> = {
  0x1: "Success",
  0xbad00000: "Fail",
  0xbad00001: "FeatureNotSupported",
  0xbad00002: "PlatformError",
  0xbad00003: "FeatureAlreadyExists",
  0xbad00004: "FeatureNotFound",
  0xbad00005: "InvalidParameter",
  0xbad00006: "ScratchBufferTooSmall",
  0xbad00007: "NotInitialized",
  0xbad00008: "UnsupportedInputFormat",
  0xbad00009: "RWFlagMissing",
  0xbad0000a: "MissingInput",
  0xbad0000b: "UnableToInitializeFeature",
  0xbad0000c: "OutOfDate",
  0xbad0000d: "OutOfGPUMemory",
  0xbad0000e: "UnsupportedFormat",
  0xbad0000f: "UnableToWriteToAppDataPath",
  0xbad00010: "UnsupportedParameter",
  0xbad00011: "Denied",
  0xbad00012: "NotImplemented",
};

export function ngxOk(result: number): boolean {
  return (result >>> 0) === NGX_SUCCESS;
}

export function ngxName(result: number): string {
  const code = result >>> 0;
  return `${RESULT_NAMES[code] ?? "Unknown"} (${hex32(code)})`;
}

export class NgxError extends Error {
  constructor(
    readonly result: number,
    what: string,
  ) {
    super(`${what}: NGX ${ngxName(result)}${hint(result)}`);
  }
}

function hint(result: number): string {
  switch (result >>> 0) {
    case 0xbad00002:
      // Any feature's call can return this (the DLSS-G host has seen it from EvaluateFeature after
      // thousands of good intervals), so the text names no feature and no single cause.
      return " - a platform error inside the NGX runtime; the runtime also returns it to callers outside a module named nvngx.dll, which is why every NGX call goes through the nvngx.dll shim";
    case 0xbad0000b:
      return " - the feature could not start; check driver version, GPU architecture and that the capability parameter block was used";
    case 0xbad00012:
      return " - this driver's NGX core does not know the feature; a newer driver is required";
    case 0xbad00001:
      return " - the feature is not supported on this GPU or driver";
    default:
      return "";
  }
}

export function ngxCheck(result: number, what: string): void {
  if (!ngxOk(result)) throw new NgxError(result, what);
}

export const NgxFeature = {
  SuperSampling: 1,
  InPainting: 2,
  ImageSuperResolution: 3,
  SlowMotion: 4,
  VideoSuperResolution: 5,
  ImageSignalProcessing: 9,
  DeepResolve: 10,
  FrameGeneration: 11,
  DeepDVC: 12,
  RayReconstruction: 13,
  /** DLSS 5 Neural Rendering. Reserved18 in the public header. */
  NeuralRendering: 18,
} as const;

export function featureName(id: number): string {
  for (const [name, value] of Object.entries(NgxFeature)) if (value === id) return name;
  return `Feature${id}`;
}

/** NVSDK_NGX_FeatureSupportResult bits (nvsdk_ngx_defs.h; 0 is "supported") and the words describeSupport gives each. */
const FEATURE_SUPPORT_BITS: ReadonlyArray<readonly [bit: number, meaning: string]> = [
  [0x01, "check not present"], // CheckNotPresent
  [0x02, "driver too old"], // DriverVersionUnsupported
  [0x04, "adapter unsupported"], // AdapterUnsupported
  [0x08, "OS too old"], // OSVersionBelowMinimumSupported
  [0x10, "not implemented"], // NotImplemented
];
const KNOWN_SUPPORT_BITS = FEATURE_SUPPORT_BITS.reduce((all, [bit]) => all | bit, 0);

export function describeSupport(bits: number): string {
  if (bits === 0) return "supported";
  const parts = FEATURE_SUPPORT_BITS.filter(([bit]) => bits & bit).map(([, meaning]) => meaning);
  const unknown = bits & ~KNOWN_SUPPORT_BITS;
  if (unknown) parts.push(`unknown bits ${hex32(unknown)}`);
  return parts.join(", ");
}

export const NGX_VERSION_API = 0x15;
/** The application id every NGX init in this project passes: "NRTS" + 1, an arbitrary non-zero id. */
export const NGX_APPLICATION_ID = 0x4e5254530001n;
export const NGX_ENGINE_TYPE_CUSTOM = 0;

export const PerfQuality = {
  MaxPerf: 0,
  Balanced: 1,
  MaxQuality: 2,
  UltraPerformance: 3,
  UltraQuality: 4,
  DLAA: 5,
} as const;

/** NVSDK_NGX_DLSS_Feature_Flags bits (verbatim from nvngx_dlss.dll / the public SDK header). */
export const DlssCreateFlag = {
  IsHDR: 0x01,
  MVLowRes: 0x02,
  MVJittered: 0x04,
  DepthInverted: 0x08,
  DoSharpening: 0x20,
  AutoExposure: 0x40,
  AlphaUpscaling: 0x80,
} as const;

/**
 * NVSDK_NGX_DLSS_Hint_Render_Preset values. Which model a preset selects is a
 * property of the loaded nvngx_dlss.dll, not of this enum: 310.7.129.0 names
 * only Preset_A..Preset_E internally, so do not document a CNN/transformer
 * split this repository cannot verify.
 */
export const DlssRenderPreset = {
  Default: 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, J: 10, K: 11, L: 12, M: 13, N: 14, O: 15,
} as const;

/** The DlssRenderPreset an SR session renders with unless asked otherwise: the CLI's --preset, the sr engine and DlssSrSession.open. */
export const DEFAULT_SR_PRESET = "L" satisfies keyof typeof DlssRenderPreset;

/**
 * The per-quality-mode preset parameter name, keyed by PerfQuality value. DLSS SR
 * exposes six per-mode preset params, not one bare hint; MaxPerf(0) uses the
 * .Performance slot. Verified verbatim in nvngx_dlss.dll.
 */
export const DLSS_PRESET_PARAM: Record<number, string> = {
  0: "DLSS.Hint.Render.Preset.Performance",
  1: "DLSS.Hint.Render.Preset.Balanced",
  2: "DLSS.Hint.Render.Preset.Quality",
  3: "DLSS.Hint.Render.Preset.UltraPerformance",
  4: "DLSS.Hint.Render.Preset.UltraQuality",
  5: "DLSS.Hint.Render.Preset.DLAA",
};

/**
 * A PerfQuality value as its NVSDK_NGX_PerfQuality_Value_* name, for messages.
 * Derived from the enum rather than tabulated: DLSS_PRESET_PARAM's path suffixes
 * are deliberately different names and must not be used for display.
 */
export function perfQualityName(value: number): string {
  return Object.keys(PerfQuality).find((k) => PerfQuality[k as keyof typeof PerfQuality] === value) ?? `PerfQuality ${value}`;
}

/**
 * The fixed output/render ratio of each PerfQuality mode this runtime accepts:
 * the inverse of NVIDIA's default per-axis render scale for the mode (NVIDIA
 * developer blog, "Tips: Getting the Most out of the DLSS Unreal Engine 4
 * Plugin", 2021-02-17: Ultra Performance 33%, Performance 50%, Balanced 58%,
 * Quality 66%). MaxQuality is NVIDIA's Quality and MaxPerf its Performance; 1.5
 * and 3.0 are the inverses of 2/3 and 1/3, 1.7241379 is 1/0.58, and DLAA
 * renders at the output size. The runtime's own GetOptimalSettings callback is
 * never queried, so these are the only ratios used.
 *
 * PerfQuality 4 (UltraQuality) is deliberately absent: nvngx_dlss.dll 310.7.129.0
 * refuses CreateFeature with UnsupportedParameter for it at every ratio tried
 * (1.3x, 1.5x, 2.0x), while 1.3x itself succeeds on modes 2 and 5 — so the mode
 * is unavailable, not the ratio. Measured by tests/diag-sr-quality-modes.ts.
 */
export const DLSS_RATIO: Record<number, number> = {
  5: 1.0, 2: 1.5, 1: 1.7241379, 0: 2.0, 3: 3.0,
};

/**
 * The PerfQuality whose fixed ratio is nearest `factor`. The one owner of that
 * rule: the CLI and the job engine must agree, or a job and its command line
 * would produce different sizes from the same number.
 *
 * A factor above 1 never snaps to DLAA. Its ratio, 1.0, is the nearest to
 * anything under 1.25 (the midpoint to MaxQuality's 1.5), so a request to
 * upscale would come back at the source size. A factor of 1 or less runs DLAA.
 */
export function qualityForFactor(factor: number): number {
  const candidates = Object.entries(DLSS_RATIO).filter(([, ratio]) => factor > 1 ? ratio > 1 : true);
  return Number(
    candidates.reduce((best, [quality, ratio]) => (Math.abs(ratio - factor) < Math.abs(DLSS_RATIO[Number(best)]! - factor) ? quality : best), candidates[0]![0]),
  );
}

/** The PerfQuality for an SR feature that renders `renderWidth` pixels wide and writes `outputWidth`: the sr command and the sr engine both take it. */
export function qualityForSizes(renderWidth: number, outputWidth: number): number {
  return qualityForFactor(outputWidth / renderWidth);
}

/**
 * The longest output side DLSS SR creates a feature for: nvngx_dlss.dll 310.7.129.0
 * takes 5600x8192 and refuses 5600x8194 with InvalidParameter (measured on an RTX 5090).
 */
export const DLSS_SR_MAX_OUTPUT_SIDE = 8192;

/**
 * Why DLSS SR cannot write `output` from a `render`-sized source, or null when it can.
 * It only enlarges: an output side shorter than the source's fails CreateFeature
 * with InvalidParameter (factors 0.25, 0.5 and 0.75 measured), as does a side
 * longer than DLSS_SR_MAX_OUTPUT_SIDE.
 */
export function srOutputProblem(render: { width: number; height: number }, output: { width: number; height: number }): string | null {
  if (output.width < render.width || output.height < render.height) {
    return `DLSS Super Resolution only enlarges: ${output.width}x${output.height} is smaller than the ${render.width}x${render.height} source. Use a factor of at least 1 (1 runs DLAA at the source size).`;
  }
  if (Math.max(output.width, output.height) > DLSS_SR_MAX_OUTPUT_SIDE) {
    return `DLSS Super Resolution writes at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side; ${output.width}x${output.height} is larger. Use a smaller factor or output size.`;
  }
  return null;
}
