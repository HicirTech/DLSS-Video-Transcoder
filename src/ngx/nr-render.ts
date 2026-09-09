/**
 * DLSS Neural Rendering (NGX feature 18, internal "CG2R") driven in-process.
 *
 * Unlike Super Resolution, feature 18 ships as a self-contained provider,
 * nvngx_dlssnr.dll, which exports the whole NVSDK_NGX_D3D12 API but NOT the
 * parameter allocator — so this session loads that DLL directly (not the driver
 * core), routes calls through the nvngx.dll forwarder shim, and hands the runtime
 * our own NgxParamObject. The DLL reads its size from DLSSNR.Width /
 * DLSSNR.Height; the generic Width/Height names do not exist in it. Neural
 * rendering is a 1:1 enhancement, so render and output size are equal.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
  D3D12_RESOURCE_STATE_COPY_SOURCE,
  D3D12_RESOURCE_STATE_COPY_DEST,
  D3D12_RESOURCE_STATE_COMMON,
  DXGI_FORMAT_R8G8B8A8_UNORM,
  linearLayout,
  type D3D12Resource,
  type D3D12GraphicsCommandList,
} from "../native/d3d12.ts";
import { viewNative } from "../native/memory.ts";
import type { GpuSession } from "../pipeline/gpu.ts";
import type { NrSettings } from "../server/api-types.ts";
import { FeatureCommonInfo, NgxCore } from "./core.ts";
import { prepareForwarderSync } from "./forwarder-runtime.ts";
import { NgxParamObject } from "./param-object.ts";
import { NrParam } from "./params.ts";
import { PerfQuality, ngxCheck } from "./results.ts";

const NR_APP_ID = 0x4e5254530001n;
const UAV = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
const NGX_MODELS = "C:\\ProgramData\\NVIDIA\\NGX\\models";

export interface NrRenderOptions {
  width: number;
  height: number;
  settings: NrSettings;
  /** Folder that holds `caller/nvngx.dll`. */
  runtimeDir: string;
  /** Folder holding the chosen nvngx_dlssnr.dll (defaults to runtimeDir/dlssnr). */
  dllDir?: string;
  appDataPath?: string;
}

export class DlssNrSession {
  private constructor(
    private readonly session: GpuSession,
    private readonly core: NgxCore,
    private readonly params: NgxParamObject,
    private readonly handle: number,
    readonly width: number,
    readonly height: number,
    private readonly settings: NrSettings,
    private readonly color: D3D12Resource,
    private readonly output: D3D12Resource,
  ) {}

  static open(session: GpuSession, opts: NrRenderOptions): DlssNrSession {
    const appData = opts.appDataPath ?? join(opts.runtimeDir, "..", "logs");
    mkdirSync(appData, { recursive: true });
    const dllDir = opts.dllDir ?? join(opts.runtimeDir, "dlssnr");
    const dll = join(dllDir, "nvngx_dlssnr.dll");

    const core = NgxCore.load({ path: dll, folder: dllDir, source: "driverstore", modifiedAt: statSync(dll).mtime });
    const { forwarder } = prepareForwarderSync(join(opts.runtimeDir, "caller"));
    core.useForwarder(forwarder);
    ngxCheck(
      core.initExt(session.device.ptr, NR_APP_ID, appData, new FeatureCommonInfo([dllDir, NGX_MODELS])),
      "DLSS NR Init_Ext",
    );

    const params = new NgxParamObject();
    params.setU32(NrParam.Width, opts.width); // output width (DLSSNR.Width, not the absent generic "Width")
    params.setU32(NrParam.Height, opts.height);
    params.setU32("PerfQualityValue", PerfQuality.DLAA);
    params.setU32("CreationNodeMask", 1);
    params.setU32("VisibilityNodeMask", 1);
    params.setU32(NrParam.Enabled, 1);
    params.setI32(NrParam.HintRenderPreset, opts.settings.preset);

    const created = core.createFeature(session.gpu.list.ptr, 18, params);
    ngxCheck(created.result, "DLSS NR CreateFeature");
    session.gpu.submitAndWait();

    const device = session.device;
    const color = device.createTexture2D({ width: opts.width, height: opts.height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "nr color" });
    const output = device.createTexture2D({ width: opts.width, height: opts.height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "nr output" });

    return new DlssNrSession(session, core, params, created.handle, opts.width, opts.height, opts.settings, color, output);
  }

  /** The runtime reads the look controls at evaluate, so every one is re-set per frame. */
  private setEvalParams(reset: boolean): void {
    const s = this.settings;
    this.params.setResource(NrParam.Color, this.color.ptr);
    this.params.setResource(NrParam.Output, this.output.ptr);
    this.params.setU32(NrParam.Reset, reset ? 1 : 0);
    this.params.setF32(NrParam.MVecScaleX, 0);
    this.params.setF32(NrParam.MVecScaleY, 0);
    this.params.setF32(NrParam.Intensity, s.intensity);
    this.params.setF32(NrParam.LocalToneStrength, s.localTone);
    this.params.setF32(NrParam.LocalStructureStrength, s.localStructure);
    this.params.setF32(NrParam.SkinStructureStrength, s.skinStructure);
    this.params.setU32(NrParam.Style, s.style);
    this.params.setU32(NrParam.UseAutoMask, s.autoMask ? 1 : 0);
    this.params.setU32(NrParam.UICorrection, s.uiCorrection ? 1 : 0);
  }

  /** Records into the session's shared command list; the caller submits it. */
  private recordEvaluate(colorRgba: Uint8Array, reset: boolean): void {
    const expected = this.width * this.height * 4;
    if (colorRgba.byteLength !== expected) throw new Error(`DLSS NR: expected ${expected} color bytes, got ${colorRgba.byteLength}`);
    const gpu = this.session.gpu;
    gpu.uploadTexture(this.color, colorRgba, UAV);
    gpu.list.transition(this.output, UAV);
    this.setEvalParams(reset);
    ngxCheck(this.core.evaluateFeature(gpu.list.ptr, this.handle, this.params), "DLSS NR EvaluateFeature");
  }

  /**
   * Async zero-copy path: records upload, evaluate and a GPU copy of the output
   * into `dst` onto the caller's `list` without submitting it, so the caller can
   * submit once and signal a fence that a CUDA encoder waits on — the frame never
   * reaches the CPU. `staging` must be an UPLOAD buffer of at least
   * linearLayout(width, height, RGBA8).totalBytes, and `dst` a row-major RGBA
   * texture of `rowPitch` bytes per row.
   */
  recordEvaluateInto(list: D3D12GraphicsCommandList, staging: D3D12Resource, colorRgba: Uint8Array, reset: boolean, dst: D3D12Resource, rowPitch: number): void {
    const expected = this.width * this.height * 4;
    if (colorRgba.byteLength !== expected) throw new Error(`DLSS NR: expected ${expected} color bytes, got ${colorRgba.byteLength}`);
    const layout = linearLayout(this.width, this.height, DXGI_FORMAT_R8G8B8A8_UNORM);
    const target = viewNative(staging.map({ begin: 0, end: 0 }), layout.totalBytes);
    if (layout.rowPitch === layout.rowBytes) target.set(colorRgba);
    else for (let y = 0; y < this.height; y++) target.set(colorRgba.subarray(y * layout.rowBytes, (y + 1) * layout.rowBytes), y * layout.rowPitch);
    staging.unmap();
    list.transition(this.color, D3D12_RESOURCE_STATE_COPY_DEST);
    list.copyTextureRegion(
      { resource: this.color },
      { resource: staging, footprint: { offset: 0, format: DXGI_FORMAT_R8G8B8A8_UNORM, width: this.width, height: this.height, rowPitch: layout.rowPitch } },
    );
    list.transition(this.color, UAV);
    list.transition(this.output, UAV);
    this.setEvalParams(reset);
    ngxCheck(this.core.evaluateFeature(list.ptr, this.handle, this.params), "DLSS NR EvaluateFeature");
    list.transition(this.output, D3D12_RESOURCE_STATE_COPY_SOURCE);
    list.transition(dst, D3D12_RESOURCE_STATE_COPY_DEST);
    list.copyTextureRegion(
      { resource: dst, footprint: { offset: 0, format: DXGI_FORMAT_R8G8B8A8_UNORM, width: this.width, height: this.height, rowPitch } },
      { resource: this.output },
    );
    list.transition(dst, D3D12_RESOURCE_STATE_COMMON);
  }

  /** Enhance one RGBA8 frame at the same size; returns the enhanced RGBA8 frame. */
  evaluate(colorRgba: Uint8Array, reset = true): Uint8Array {
    this.recordEvaluate(colorRgba, reset);
    return this.session.gpu.readbackTexture(this.output, UAV);
  }

  close(): void {
    this.core.releaseFeature(this.handle);
    this.params.close();
    this.color.release();
    this.output.release();
    // No Shutdown1: the standalone dlssnr DLL survives it, but the SR path cannot
    // (see sr.ts), so both leave NGX to process exit. The session owns the device.
  }
}
