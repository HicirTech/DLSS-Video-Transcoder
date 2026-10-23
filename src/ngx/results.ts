/**
 * NGX result codes and support bit flags, from the public nvsdk_ngx_defs.h in NVIDIA's DLSS SDK, and the values
 * every NGX init here passes.
 */
import { hex32 } from "../native/memory.ts";
import type { SupportLevel } from "../server/api-types.ts";
import { NgxFeature } from "./feature-ids.ts";

export { NgxFeature } from "./feature-ids.ts";

/** NVSDK_NGX_Result values (nvsdk_ngx_defs.h). */
export const NgxResult = {
  Success: 0x1,
  Fail: 0xbad00000,
  FeatureNotSupported: 0xbad00001,
  PlatformError: 0xbad00002,
  FeatureAlreadyExists: 0xbad00003,
  FeatureNotFound: 0xbad00004,
  InvalidParameter: 0xbad00005,
  ScratchBufferTooSmall: 0xbad00006,
  NotInitialized: 0xbad00007,
  UnsupportedInputFormat: 0xbad00008,
  RWFlagMissing: 0xbad00009,
  MissingInput: 0xbad0000a,
  UnableToInitializeFeature: 0xbad0000b,
  OutOfDate: 0xbad0000c,
  OutOfGPUMemory: 0xbad0000d,
  UnsupportedFormat: 0xbad0000e,
  UnableToWriteToAppDataPath: 0xbad0000f,
  UnsupportedParameter: 0xbad00010,
  Denied: 0xbad00011,
  NotImplemented: 0xbad00012,
} as const;

export const NGX_SUCCESS = NgxResult.Success;

const RESULT_NAMES: Record<number, string> = Object.fromEntries(Object.entries(NgxResult).map(([name, code]) => [code, name]));

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
    case NgxResult.PlatformError:
      // Any feature's call can return this (the DLSS-G host has seen it from EvaluateFeature after
      // thousands of good intervals), so the text names no feature and no single cause.
      return " - a platform error inside the NGX runtime; the runtime also returns it to callers outside a module named nvngx.dll, which is why every NGX call goes through the nvngx.dll shim";
    case NgxResult.UnableToInitializeFeature:
      return " - the feature could not start; check the driver version and GPU architecture (`probe` reports both), or try another installed feature DLL (`versions` lists them)";
    case NgxResult.NotImplemented:
      return " - this driver's NGX core does not know the feature; a newer driver is required";
    case NgxResult.FeatureNotSupported:
      return " - the feature is not supported on this GPU or driver";
    default:
      return "";
  }
}

export function ngxCheck(result: number, what: string): void {
  if (!ngxOk(result)) throw new NgxError(result, what);
}

export function featureName(id: number): string {
  for (const [name, value] of Object.entries(NgxFeature)) if (value === id) return name;
  return `Feature${id}`;
}

/** NVSDK_NGX_FeatureSupportResult bits (nvsdk_ngx_defs.h; 0 is "supported"), the words describeSupport gives each, and how usable each leaves the feature. */
const FEATURE_SUPPORT_BITS: ReadonlyArray<readonly [bit: number, meaning: string, level: Exclude<SupportLevel, "supported">]> = [
  [0x01, "check not present", "unknown"], // CheckNotPresent
  [0x02, "driver too old", "outdated"], // DriverVersionUnsupported
  [0x04, "adapter unsupported", "blocked"], // AdapterUnsupported
  [0x08, "OS too old", "outdated"], // OSVersionBelowMinimumSupported
  [0x10, "not implemented", "blocked"], // NotImplemented
];
const KNOWN_SUPPORT_BITS = FEATURE_SUPPORT_BITS.reduce((all, [bit]) => all | bit, 0);
const LEVEL_SEVERITY: Record<Exclude<SupportLevel, "supported">, number> = { unknown: 0, outdated: 1, blocked: 2 };

export function describeSupport(bits: number): string {
  if (bits === 0) return "supported";
  const parts = FEATURE_SUPPORT_BITS.filter(([bit]) => bits & bit).map(([, meaning]) => meaning);
  const unknown = bits & ~KNOWN_SUPPORT_BITS;
  if (unknown) parts.push(`unknown bits ${hex32(unknown)}`);
  return parts.join(", ");
}

/** How usable the support bits leave a feature: the most severe level among the bits set, an unknown bit counting as "unknown". */
export function supportLevel(bits: number): SupportLevel {
  if (bits === 0) return "supported";
  const levels = FEATURE_SUPPORT_BITS.filter(([bit]) => bits & bit).map(([, , level]) => level);
  return levels.reduce((worst, level) => (LEVEL_SEVERITY[level] > LEVEL_SEVERITY[worst] ? level : worst), "unknown" as Exclude<SupportLevel, "supported">);
}

/** The support words for a feature the bits do not describe: not asked, or the query itself failed or was refused. */
export const SUPPORT_NOT_QUERIED = "not queried";
export const SUPPORT_QUERY_FAILED = "query failed";
export const SUPPORT_NOT_REPORTED = "not reported by this driver";

/** NVSDK_NGX_Version_API (nvsdk_ngx_defs.h). */
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
 * exposes six per-mode preset params, not one bare hint; MaxPerf uses the
 * .Performance slot. Verified verbatim in nvngx_dlss.dll.
 */
export const DLSS_PRESET_PARAM: Record<number, string> = {
  [PerfQuality.MaxPerf]: "DLSS.Hint.Render.Preset.Performance",
  [PerfQuality.Balanced]: "DLSS.Hint.Render.Preset.Balanced",
  [PerfQuality.MaxQuality]: "DLSS.Hint.Render.Preset.Quality",
  [PerfQuality.UltraPerformance]: "DLSS.Hint.Render.Preset.UltraPerformance",
  [PerfQuality.UltraQuality]: "DLSS.Hint.Render.Preset.UltraQuality",
  [PerfQuality.DLAA]: "DLSS.Hint.Render.Preset.DLAA",
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
 * never queried: an output of the source size times the requested factor renders
 * at the source size, and these ratios only pick the mode (qualityForFactor).
 *
 * PerfQuality 4 (UltraQuality) is deliberately absent: nvngx_dlss.dll 310.7.129.0
 * refuses CreateFeature with UnsupportedParameter for it at every ratio tried
 * (1.3x, 1.5x, 2.0x), while 1.3x itself succeeds on modes 2 and 5 — so the mode
 * is unavailable, not the ratio. Measured by tests/diag-sr-quality-modes.ts.
 */
export const DLSS_RATIO: Record<number, number> = {
  [PerfQuality.DLAA]: 1.0,
  [PerfQuality.MaxQuality]: 1.5,
  [PerfQuality.Balanced]: 1.7241379,
  [PerfQuality.MaxPerf]: 2.0,
  [PerfQuality.UltraPerformance]: 3.0,
};

/**
 * The PerfQuality whose fixed ratio is nearest `factor`: the mode an SR feature
 * is created in for an output of the source size times `factor`.
 *
 * A factor above 1 never picks DLAA. Its ratio, 1.0, is the nearest to anything
 * under 1.25 (the midpoint to MaxQuality's 1.5), but DLAA renders at the output
 * size. A factor of 1 runs DLAA.
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
