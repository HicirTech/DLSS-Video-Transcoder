/**
 * DLSS Super Resolution (NGX feature 1) driven in-process.
 *
 * The driver NGX core (`_nvngx.dll`) loads `nvngx_dlss.dll` from the feature
 * search path and owns the parameter allocator, so this session inits the core
 * (through the nvngx.dll forwarder shim so the runtime's caller-module check
 * passes), creates the feature once, then evaluates one frame at a time on
 * GPU-resident textures.
 *
 * Teardown: this driver core's Shutdown1 frees the D3D12 device and faults once a
 * feature has been created, so close() releases the feature and its resources but
 * never calls it — NGX is reclaimed at process exit. Reuse one session across
 * jobs, or run one job per short-lived process.
 */
import { mkdirSync } from "node:fs";
import {
  D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
  DXGI_FORMAT_R8G8B8A8_UNORM,
  DXGI_FORMAT_R16G16_FLOAT,
  DXGI_FORMAT_R32_FLOAT,
  type D3D12Resource,
} from "../native/d3d12.ts";
import { APP_DATA_DIR, callerDir, featureDir } from "../paths.ts";
import type { GpuSession } from "../pipeline/gpu.ts";
import { FeatureCommonInfo, NgxCore } from "./core.ts";
import { prepareForwarderSync } from "./forwarder-runtime.ts";
import { encodeMotionR16G16 } from "../pipeline/half-float.ts";
import { NgxParam, NgxParameters } from "./params.ts";
import { DEFAULT_SR_PRESET, DLSS_PRESET_PARAM, DlssCreateFlag, DlssRenderPreset, NGX_APPLICATION_ID, ngxCheck, srOutputProblem } from "./results.ts";

const UAV = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;

export interface SrOptions {
  /** Input (render) size fed to DLSS. */
  renderWidth: number;
  renderHeight: number;
  /** Output (upscaled) size DLSS writes. */
  outputWidth: number;
  outputHeight: number;
  /** PerfQuality value (0 MaxPerf .. 5 DLAA); default 0 (Performance, 2x). */
  quality?: number;
  /** DlssRenderPreset value; default DEFAULT_SR_PRESET. Which model a preset selects belongs to the loaded nvngx_dlss.dll — see DlssRenderPreset in results.ts. */
  preset?: number;
  /** Folder that holds `caller/nvngx.dll` and `dlss/nvngx_dlss.dll`. */
  runtimeDir: string;
  /** Folder holding the chosen nvngx_dlss.dll version (defaults to runtimeDir/dlss). Enables version switching. */
  dllDir?: string;
  appDataPath?: string;
}

export class DlssSrSession {
  private constructor(
    private readonly session: GpuSession,
    private readonly core: NgxCore,
    private readonly params: NgxParameters,
    private readonly handle: number,
    readonly renderWidth: number,
    readonly renderHeight: number,
    readonly outputWidth: number,
    readonly outputHeight: number,
    private readonly color: D3D12Resource,
    private readonly output: D3D12Resource,
    private readonly depth: D3D12Resource,
    private readonly motion: D3D12Resource,
    private readonly forwarderKeep: unknown,
  ) {}

  static open(session: GpuSession, opts: SrOptions): DlssSrSession {
    // Named here, before anything is created: CreateFeature only answers InvalidParameter.
    const sizeProblem = srOutputProblem({ width: opts.renderWidth, height: opts.renderHeight }, { width: opts.outputWidth, height: opts.outputHeight });
    if (sizeProblem) throw new Error(sizeProblem);
    const appData = opts.appDataPath ?? APP_DATA_DIR;
    mkdirSync(appData, { recursive: true });

    const core = NgxCore.load(); // driver core
    const { forwarder } = prepareForwarderSync(callerDir(opts.runtimeDir));
    core.useForwarder(forwarder);
    ngxCheck(
      core.initExt(session.device.ptr, NGX_APPLICATION_ID, appData, new FeatureCommonInfo([opts.dllDir ?? featureDir(opts.runtimeDir, "sr")])),
      "DLSS SR Init_Ext",
    );

    const quality = opts.quality ?? 0;
    const params = core.allocateParameters();
    NgxParameters.detectLayout(params);
    params.setU32(NgxParam.PerfQualityValue, quality);
    params.setU32(NgxParam.Width, opts.renderWidth);
    params.setU32(NgxParam.Height, opts.renderHeight);
    params.setU32(NgxParam.OutWidth, opts.outputWidth);
    params.setU32(NgxParam.OutHeight, opts.outputHeight);
    // MVLowRes: our motion vectors live in the render-resolution texture with
    // MV.Scale = 1 (render pixels). Without this flag DLSS treats them as
    // display-resolution and mis-scales temporal reconstruction (ghosting on
    // upscaled video). Correct at DLAA too, where render == output.
    params.setU32(NgxParam.DlssCreateFlags, DlssCreateFlag.AutoExposure | DlssCreateFlag.MVLowRes);
    params.setU32(DLSS_PRESET_PARAM[quality] ?? DLSS_PRESET_PARAM[0]!, opts.preset ?? DlssRenderPreset[DEFAULT_SR_PRESET]);
    params.setU32(NgxParam.CreationNodeMask, 1);
    params.setU32(NgxParam.VisibilityNodeMask, 1);

    const created = core.createFeature(session.gpu.list.ptr, 1, params);
    ngxCheck(created.result, "DLSS SR CreateFeature");
    session.gpu.submitAndWait();

    const device = session.device;
    const color = device.createTexture2D({ width: opts.renderWidth, height: opts.renderHeight, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "sr color" });
    const output = device.createTexture2D({ width: opts.outputWidth, height: opts.outputHeight, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "sr output" });
    const depth = device.createTexture2D({ width: opts.renderWidth, height: opts.renderHeight, format: DXGI_FORMAT_R32_FLOAT, allowUnorderedAccess: true, label: "sr depth" });
    const motion = device.createTexture2D({ width: opts.renderWidth, height: opts.renderHeight, format: DXGI_FORMAT_R16G16_FLOAT, allowUnorderedAccess: true, label: "sr motion" });
    // Depth and motion are unused for still images; initialise them to zero once.
    session.gpu.uploadTexture(depth, new Uint8Array(opts.renderWidth * opts.renderHeight * 4), UAV);
    session.gpu.uploadTexture(motion, new Uint8Array(opts.renderWidth * opts.renderHeight * 4), UAV);
    session.gpu.submitAndWait();

    return new DlssSrSession(session, core, params, created.handle, opts.renderWidth, opts.renderHeight, opts.outputWidth, opts.outputHeight, color, output, depth, motion, forwarder);
  }

  /** Upscale one render-resolution RGBA8 frame; returns the output-resolution RGBA8 frame. */
  evaluate(colorRgba: Uint8Array, reset = true, motion: Float32Array | null = null): Uint8Array {
    const expected = this.renderWidth * this.renderHeight * 4;
    if (colorRgba.byteLength !== expected) throw new Error(`DLSS SR: expected ${expected} color bytes, got ${colorRgba.byteLength}`);
    const gpu = this.session.gpu;
    gpu.uploadTexture(this.color, colorRgba, UAV);
    if (motion) {
      const half = encodeMotionR16G16(motion);
      gpu.uploadTexture(this.motion, new Uint8Array(half.buffer, half.byteOffset, half.byteLength), UAV);
    }
    gpu.list.transition(this.output, UAV);
    this.params.setResource(NgxParam.Color, this.color.ptr);
    this.params.setResource(NgxParam.Output, this.output.ptr);
    this.params.setResource(NgxParam.Depth, this.depth.ptr);
    this.params.setResource(NgxParam.MotionVectors, this.motion.ptr);
    this.params.setF32(NgxParam.MVScaleX, motion ? 1 : 0);
    this.params.setF32(NgxParam.MVScaleY, motion ? 1 : 0);
    this.params.setF32(NgxParam.JitterOffsetX, 0);
    this.params.setF32(NgxParam.JitterOffsetY, 0);
    this.params.setU32(NgxParam.Reset, reset ? 1 : 0);
    this.params.setU32(NgxParam.RenderSubrectWidth, this.renderWidth);
    this.params.setU32(NgxParam.RenderSubrectHeight, this.renderHeight);
    ngxCheck(this.core.evaluateFeature(gpu.list.ptr, this.handle, this.params), "DLSS SR EvaluateFeature");
    return gpu.readbackTexture(this.output, UAV);
  }

  close(): void {
    this.core.releaseFeature(this.handle);
    this.core.destroyParameters(this.params);
    this.color.release();
    this.output.release();
    this.depth.release();
    this.motion.release();
    void this.forwarderKeep;
    // Deliberately no Shutdown1: this driver core faults on it after a create.
  }
}
