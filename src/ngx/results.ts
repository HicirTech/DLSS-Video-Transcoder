/**
 * NGX result codes, feature ids and support bit flags, from the public
 * nvsdk_ngx_defs.h in NVIDIA's DLSS SDK.
 */
import { hex32 } from "../native/memory.ts";

export const NGX_SUCCESS = 0x1;
export const NGX_FAIL = 0xbad00000;

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
      return " - the runtime refused the caller; feature 18 requires calls to come from a module named nvngx.dll";
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

export const FeatureSupport = {
  Supported: 0,
  CheckNotPresent: 1,
  DriverVersionUnsupported: 2,
  AdapterUnsupported: 4,
  OSVersionBelowMinimumSupported: 8,
  NotImplemented: 16,
} as const;

export function describeSupport(bits: number): string {
  if (bits === 0) return "supported";
  const parts: string[] = [];
  if (bits & 1) parts.push("check not present");
  if (bits & 2) parts.push("driver too old");
  if (bits & 4) parts.push("adapter unsupported");
  if (bits & 8) parts.push("OS too old");
  if (bits & 16) parts.push("not implemented");
  if (bits & ~31) parts.push(`unknown bits ${hex32(bits & ~31)}`);
  return parts.join(", ");
}

export const NGX_VERSION_API = 0x15;
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

/** NVSDK_NGX_DLSS_Hint_Render_Preset values. J/K/L/M (10-13) are the transformer-model presets. */
export const DlssRenderPreset = {
  Default: 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, J: 10, K: 11, L: 12, M: 13, N: 14, O: 15,
} as const;

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

/** Output/render ratio per PerfQuality (fallback when GetOptimalSettings is not queried). */
export const DLSS_RATIO: Record<number, number> = {
  5: 1.0, 2: 1.5, 1: 1.7241379, 0: 2.0, 3: 3.0, 4: 1.3,
};
