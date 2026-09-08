/**
 * NGX parameter objects and parameter names.
 *
 * The driver's NGX core does not export the C helpers
 * (NVSDK_NGX_Parameter_SetI and friends); those live in NVIDIA's static
 * library and simply call virtual methods on the NVSDK_NGX_Parameter object.
 * So this module calls the vtable directly.
 *
 * The interface declares eight `Set` overloads, eight `Get` overloads and
 * `Reset`. MSVC lays adjacent overloads out in reverse declaration order, so
 * the slot table below defaults to that layout; `detectLayout()` confirms it at
 * runtime by round-tripping a float through the object.
 */
import { FFIType } from "bun:ffi";
import { vtableMethod } from "../native/com.ts";
import { OutF32, OutU32, OutU64, cstring } from "../native/memory.ts";
import { ngxOk } from "./results.ts";

export type VtableLayout = "msvc" | "declared";

interface Slots {
  setU64: number;
  setF32: number;
  setF64: number;
  setU32: number;
  setI32: number;
  setD3d11: number;
  setD3d12: number;
  setPointer: number;
  getU64: number;
  getF32: number;
  getF64: number;
  getU32: number;
  getI32: number;
  getD3d11: number;
  getD3d12: number;
  getPointer: number;
  reset: number;
}

const DECLARED: Slots = {
  setU64: 0, setF32: 1, setF64: 2, setU32: 3, setI32: 4, setD3d11: 5, setD3d12: 6, setPointer: 7,
  getU64: 8, getF32: 9, getF64: 10, getU32: 11, getI32: 12, getD3d11: 13, getD3d12: 14, getPointer: 15,
  reset: 16,
};

const MSVC: Slots = {
  setPointer: 0, setD3d12: 1, setD3d11: 2, setI32: 3, setU32: 4, setF64: 5, setF32: 6, setU64: 7,
  getPointer: 8, getD3d12: 9, getD3d11: 10, getI32: 11, getU32: 12, getF64: 13, getF32: 14, getU64: 15,
  reset: 16,
};

const nameCache = new Map<string, Uint8Array>();

function name(text: string): Uint8Array {
  let bytes = nameCache.get(text);
  if (!bytes) {
    bytes = cstring(text);
    nameCache.set(text, bytes);
  }
  return bytes;
}

export class NgxParameters {
  static layout: VtableLayout = "msvc";

  constructor(
    readonly ptr: number,
    readonly origin: "capability" | "allocated",
  ) {
    if (ptr === 0) throw new Error("NgxParameters: null parameter object");
  }

  private get slots(): Slots {
    return NgxParameters.layout === "msvc" ? MSVC : DECLARED;
  }

  private setter(slot: number, valueType: FFIType) {
    return vtableMethod(this.ptr, slot, { args: [FFIType.ptr, valueType], returns: FFIType.void });
  }

  private getter(slot: number) {
    return vtableMethod(this.ptr, slot, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
  }

  setU32(key: string, value: number): void {
    this.setter(this.slots.setU32, FFIType.u32)(this.ptr, name(key), value >>> 0);
  }

  setI32(key: string, value: number): void {
    this.setter(this.slots.setI32, FFIType.i32)(this.ptr, name(key), value | 0);
  }

  setF32(key: string, value: number): void {
    this.setter(this.slots.setF32, FFIType.f32)(this.ptr, name(key), value);
  }

  setF64(key: string, value: number): void {
    this.setter(this.slots.setF64, FFIType.f64)(this.ptr, name(key), value);
  }

  setU64(key: string, value: bigint | number): void {
    this.setter(this.slots.setU64, FFIType.u64)(this.ptr, name(key), BigInt(value));
  }

  setResource(key: string, resource: number): void {
    this.setter(this.slots.setD3d12, FFIType.ptr)(this.ptr, name(key), resource === 0 ? null : resource);
  }

  setPointer(key: string, pointer: number): void {
    this.setter(this.slots.setPointer, FFIType.ptr)(this.ptr, name(key), pointer === 0 ? null : pointer);
  }

  getU32(key: string): number | null {
    const out = new OutU32();
    const result = this.getter(this.slots.getU32)(this.ptr, name(key), out.ptr) as number;
    return ngxOk(result) ? out.value : null;
  }

  getI32(key: string): number | null {
    const out = new OutU32();
    const result = this.getter(this.slots.getI32)(this.ptr, name(key), out.ptr) as number;
    return ngxOk(result) ? out.value | 0 : null;
  }

  getF32(key: string): number | null {
    const out = new OutF32();
    const result = this.getter(this.slots.getF32)(this.ptr, name(key), out.ptr) as number;
    return ngxOk(result) ? out.value : null;
  }

  getU64(key: string): bigint | null {
    const out = new OutU64();
    const result = this.getter(this.slots.getU64)(this.ptr, name(key), out.ptr) as number;
    return ngxOk(result) ? out.value : null;
  }

  getPointer(key: string): number | null {
    const out = new OutU64();
    const result = this.getter(this.slots.getPointer)(this.ptr, name(key), out.ptr) as number;
    return ngxOk(result) ? Number(out.value) : null;
  }

  reset(): void {
    vtableMethod(this.ptr, this.slots.reset, { args: [], returns: FFIType.void })(this.ptr);
  }

  /**
   * Confirm which overload order the loaded core uses by writing a float through
   * one layout's `Set(float)` slot and reading it back through its `Get(float*)`
   * slot. Sets `NgxParameters.layout` on success.
   */
  static detectLayout(params: NgxParameters): VtableLayout | "unknown" {
    const key = "NeuralRenderTs.LayoutProbe";
    const value = 0.3125;
    for (const candidate of ["msvc", "declared"] as const) {
      const slots = candidate === "msvc" ? MSVC : DECLARED;
      const setF = vtableMethod(params.ptr, slots.setF32, { args: [FFIType.ptr, FFIType.f32], returns: FFIType.void });
      setF(params.ptr, name(key), value);
      const out = new OutF32();
      const getF = vtableMethod(params.ptr, slots.getF32, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
      const result = getF(params.ptr, name(key), out.ptr) as number;
      if (ngxOk(result) && Math.abs(out.value - value) < 1e-6) {
        NgxParameters.layout = candidate;
        return candidate;
      }
    }
    return "unknown";
  }
}

/** Public DLSS parameter names (nvsdk_ngx_defs.h). */
export const NgxParam = {
  Width: "Width",
  Height: "Height",
  OutWidth: "OutWidth",
  OutHeight: "OutHeight",
  Scale: "Scale",
  PerfQualityValue: "PerfQualityValue",
  Color: "Color",
  Output: "Output",
  Depth: "Depth",
  MotionVectors: "MotionVectors",
  Reset: "Reset",
  MVScaleX: "MV.Scale.X",
  MVScaleY: "MV.Scale.Y",
  JitterOffsetX: "Jitter.Offset.X",
  JitterOffsetY: "Jitter.Offset.Y",
  Sharpness: "Sharpness",
  CreationNodeMask: "CreationNodeMask",
  VisibilityNodeMask: "VisibilityNodeMask",
  DlssCreateFlags: "DLSS.Feature.Create.Flags",
  DlssOptimalSettingsCallback: "DLSSOptimalSettingsCallback",
  RenderSubrectWidth: "DLSS.Render.Subrect.Dimensions.Width",
  RenderSubrectHeight: "DLSS.Render.Subrect.Dimensions.Height",
  FrameTimeDeltaInMsec: "FrameTimeDeltaInMsec",
  SnippetOptLevel: "Snippet.OptLevel",
  SnippetIsDevBranch: "Snippet.IsDevBranch",
  SuperSamplingAvailable: "SuperSampling.Available",
  SuperSamplingNeedsUpdatedDriver: "SuperSampling.NeedsUpdatedDriver",
  SuperSamplingMinDriverVersionMajor: "SuperSampling.MinDriverVersionMajor",
  SuperSamplingMinDriverVersionMinor: "SuperSampling.MinDriverVersionMinor",
  SuperSamplingFeatureInitResult: "SuperSampling.FeatureInitResult",
  FrameGenerationAvailable: "FrameGeneration.Available",
  FrameGenerationNeedsUpdatedDriver: "FrameGeneration.NeedsUpdatedDriver",
  FrameGenerationMinDriverVersionMajor: "FrameGeneration.MinDriverVersionMajor",
  FrameGenerationMinDriverVersionMinor: "FrameGeneration.MinDriverVersionMinor",
  RayReconstructionAvailable: "RayReconstruction.Available",
} as const;

/**
 * DLSS 5 Neural Rendering (feature 18) parameter names. These are not in any
 * public header; they were established by the community from shipping
 * integrations. Types follow the observed usage: integers for switches and
 * hints, floats for strengths, D3D12 resources for images.
 */
export const NrParam = {
  Enabled: "DLSSNR.Enabled",
  Width: "DLSSNR.Width",
  Height: "DLSSNR.Height",
  InputWidth: "DLSSNR.InputWidth",
  InputHeight: "DLSSNR.InputHeight",
  OutputWidth: "DLSSNR.OutputWidth",
  OutputHeight: "DLSSNR.OutputHeight",
  Upscaling: "DLSSNR.Upscaling",
  Scale: "DLSSNR.Scale",
  ScalingRatio: "DLSSNR.ScalingRatio",
  HintRenderPreset: "DLSSNR.Hint.Render.Preset",
  Intensity: "DLSSNR.Intensity",
  Style: "DLSSNR.Style",
  LocalStructureStrength: "DLSSNR.LocalStructureStrength",
  LocalToneStrength: "DLSSNR.LocalToneStrength",
  SkinStructureStrength: "DLSSNR.SkinStructureStrength",
  GlobalToneStrength: "DLSSNR.GlobalToneStrength",
  UseAutoMask: "DLSSNR.UseAutoMask",
  UICorrection: "DLSSNR.UICorrection",
  Color: "DLSSNR.Color",
  Depth: "DLSSNR.Depth",
  MVec: "DLSSNR.MVec",
  Output: "DLSSNR.Output",
  Reset: "DLSSNR.Reset",
  DepthInverted: "DLSSNR.DepthInverted",
  MVecScaleX: "DLSSNR.MVecScaleX",
  MVecScaleY: "DLSSNR.MVecScaleY",
  ColorSubrectBaseX: "DLSSNR.ColorSubrectBaseX",
  ColorSubrectBaseY: "DLSSNR.ColorSubrectBaseY",
  ColorSubrectWidth: "DLSSNR.ColorSubrectWidth",
  ColorSubrectHeight: "DLSSNR.ColorSubrectHeight",
  DepthSubrectBaseX: "DLSSNR.DepthSubrectBaseX",
  DepthSubrectBaseY: "DLSSNR.DepthSubrectBaseY",
  DepthSubrectWidth: "DLSSNR.DepthSubrectWidth",
  DepthSubrectHeight: "DLSSNR.DepthSubrectHeight",
  MVecSubrectBaseX: "DLSSNR.MVecSubrectBaseX",
  MVecSubrectBaseY: "DLSSNR.MVecSubrectBaseY",
  MVecSubrectWidth: "DLSSNR.MVecSubrectWidth",
  MVecSubrectHeight: "DLSSNR.MVecSubrectHeight",
  OutputSubrectBaseX: "DLSSNR.OutputSubrectBaseX",
  OutputSubrectBaseY: "DLSSNR.OutputSubrectBaseY",
  OutputSubrectWidth: "DLSSNR.OutputSubrectWidth",
  OutputSubrectHeight: "DLSSNR.OutputSubrectHeight",
  /** Capability names are guesses modelled on the DLSS ones; the probe reports whichever answer. */
  Available: "DLSSNR.Available",
  NeedsUpdatedDriver: "DLSSNR.NeedsUpdatedDriver",
  MinDriverVersionMajor: "DLSSNR.MinDriverVersionMajor",
  MinDriverVersionMinor: "DLSSNR.MinDriverVersionMinor",
  FeatureInitResult: "DLSSNR.FeatureInitResult",
} as const;
