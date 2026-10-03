/**
 * DLSS Frame Generation (NGX feature 11) driven in-process: one feature per frame size, and per
 * source interval N generated frames recorded on one command list and read back in one submit.
 *
 * NGX is initialised once per process and never shut down (core.ts), so a process makes one
 * probe() or one open(), and a feature that has to be recreated means a new process.
 */
import { ptr } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
  D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
  DXGI_FORMAT_R8G8B8A8_UNORM,
  DXGI_FORMAT_R16G16_FLOAT,
  DXGI_FORMAT_R32_FLOAT,
  type D3D12Device,
  type D3D12Resource,
} from "../native/d3d12.ts";
import type { Readback } from "../native/gpu-context.ts";
import { asPtr } from "../native/memory.ts";
import { NGX_DATA_DIR } from "../paths.ts";
import { dlssgIntervalConstants, type DlssgIntervalConstants } from "../pipeline/dlssg-constants.ts";
import type { GpuSession } from "../pipeline/gpu.ts";
import { FeatureCommonInfo, NgxCore } from "./core.ts";
import { DlssgCapabilityParam, DlssgCreateParam, DlssgEvaluateParam } from "./dlssg-params.ts";
import { DISABLE_FLAG_BUFFER_BYTES, DISABLE_FLAG_UNWRITTEN, classifyInterval, intervalEvaluateCalls, type EvaluateCall } from "./dlssg-interval.ts";
import { prepareForwarderSync } from "./forwarder-runtime.ts";
import { NgxParam, NgxParameters } from "./params.ts";
import { NGX_APPLICATION_ID, NgxFeature, ngxCheck, ngxName } from "./results.ts";

const INPUT_STATE = D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE;
const UAV = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;

export interface DlssgRuntimeOptions {
  /** Folder holding nvngx_dlssg.dll, the feature's only search path. */
  runtimeDir: string;
  /** Folder for the generated nvngx.dll caller shim; never runtimeDir (checkShimPlacement). */
  callerDir: string;
  appDataPath?: string;
}

interface DlssgFeatureOptions extends DlssgRuntimeOptions {
  width: number;
  height: number;
  /** Most frames any interval will generate; one output texture and one disable flag each. */
  maxGenerated: number;
}

export interface DlssgCapabilities {
  available: boolean;
  needsUpdatedDriver: boolean;
  /** "major.minor" of the oldest driver the runtime accepts, when it reports one. */
  minDriverVersion: string | null;
  /** An NVSDK_NGX_Result saying why the feature could not start; null when the runtime reports none. */
  featureInitResult: number | null;
  /** Most frames one interval can generate; 1 (2x only) when the runtime reports 1 or less, or nothing (nvsdk_ngx_defs_dlssg.h:350-353). */
  multiFrameCountMax: number;
}

export interface DlssgIntervalInput {
  /** The current source frame, tightly packed RGBA8. */
  rgba: Uint8Array;
  /**
   * The protocol's half2 motion field: R16G16_FLOAT, backward (current to previous) vectors in
   * pixels, +x right and +y down, exactly as the guide worker packs it (flow-resize.ts).
   */
  motion: Uint8Array;
  /** Start a new history (first frame, scene cut, segment start); such an interval generates nothing. */
  reset: boolean;
  /** Source frame index, one step per source frame. */
  frameId: number;
  /** Frames to generate between the previous source frame and this one, 1..maxGenerated. */
  generatedCount: number;
}

export type DlssgIntervalResult =
  /** Exactly generatedCount frames, earliest first: frame k sits at k/(generatedCount+1) of the interval. */
  | { outcome: "generated"; frames: Uint8Array[] }
  /** A reset interval: the frame started a new history, so there is no interval to fill (the protocol's "empty"). */
  | { outcome: "reset" }
  /** The runtime declined a normal interval: it copied the current frame into every output instead of interpolating. */
  | { outcome: "disabled" };

type DlssgRefusal = "driverTooOld" | "unsupported" | "tooManyGenerated";

/** The runtime cannot provide what open() asked for; carries what it reported so a host can still answer its setup. */
export class DlssgUnavailableError extends Error {
  constructor(
    readonly reason: DlssgRefusal,
    readonly capabilities: DlssgCapabilities,
    detail: string,
  ) {
    super(`DLSS Frame Generation is unavailable: ${detail}`);
    this.name = "DlssgUnavailableError";
  }
}

/** The feature can no longer produce correct output; nothing in this process can repair it. */
export class DlssgFeatureStaleError extends Error {
  constructor(cause: string) {
    super(`DLSS Frame Generation has to be recreated: ${cause}. Neither another interval nor a Reset repairs this; end this process and start a new one, which creates a fresh feature.`);
    this.name = "DlssgFeatureStaleError";
  }
}

/** The runtime interpolated across a reset instead of starting a new history, so every scene cut would come out blended. */
export class DlssgResetIgnoredError extends Error {
  constructor(frameId: number) {
    super(
      `DLSS Frame Generation: this nvngx_dlssg.dll did not honour Reset at source frame ${frameId}; it interpolated across the reset, so every scene cut would show blended frames. Use another nvngx_dlssg.dll (310.7.129 and 310.9.1 honour it).`,
    );
    this.name = "DlssgResetIgnoredError";
  }
}

interface IntervalResources {
  backbuffer: D3D12Resource;
  motion: D3D12Resource;
  depth: D3D12Resource;
  /** One per MultiFrameIndex: the runtime writes each index's frame into its own texture. */
  outputs: D3D12Resource[];
  disableFlags: D3D12Resource[];
}

/**
 * The shim is generated into callerDir as nvngx.dll (runtime/caller, which can be deleted at any
 * time), so callerDir must not be runtimeDir, the folder NGX searches for NVIDIA's own files.
 */
function checkShimPlacement(options: DlssgRuntimeOptions): void {
  // Windows folder names compare case-insensitively.
  if (resolve(options.callerDir).toLowerCase() !== resolve(options.runtimeDir).toLowerCase()) return;
  throw new Error(
    `DLSS Frame Generation: the caller shim folder is the runtime folder (${options.runtimeDir}); the generated nvngx.dll shim must not sit among NVIDIA's own runtime files. Pass a separate folder such as runtime/caller.`,
  );
}

function initCore(session: GpuSession, options: DlssgRuntimeOptions): { core: NgxCore; forwarder: unknown } {
  checkShimPlacement(options);
  const appData = options.appDataPath ?? NGX_DATA_DIR;
  mkdirSync(appData, { recursive: true });
  const core = NgxCore.load();
  // Mandatory for feature 11 too: without the shim Init_Ext faults inside the driver core (measured on 310.9.1).
  const { forwarder } = prepareForwarderSync(options.callerDir);
  core.useForwarder(forwarder);
  // A relative search path makes the core's signed load of the snippet fail, and the feature then
  // reports itself unavailable (measured with nvngx_dlssg 310.7.129, driver 616.92).
  const searchPath = resolve(options.runtimeDir);
  ngxCheck(core.initExt(session.device.ptr, NGX_APPLICATION_ID, appData, new FeatureCommonInfo([searchPath])), "DLSS Frame Generation Init_Ext");
  return { core, forwarder };
}

function readCapabilities(core: NgxCore): DlssgCapabilities {
  const caps = core.capabilityParameters();
  const driverMajor = caps.getU32(NgxParam.FrameGenerationMinDriverVersionMajor);
  const driverMinor = caps.getU32(NgxParam.FrameGenerationMinDriverVersionMinor);
  return {
    available: caps.getU32(NgxParam.FrameGenerationAvailable) === 1,
    needsUpdatedDriver: caps.getU32(NgxParam.FrameGenerationNeedsUpdatedDriver) === 1,
    minDriverVersion: driverMajor === null ? null : `${driverMajor}.${driverMinor ?? 0}`,
    featureInitResult: caps.getI32(NgxParam.FrameGenerationFeatureInitResult),
    multiFrameCountMax: Math.max(1, caps.getU32(DlssgCapabilityParam.MultiFrameCountMax) ?? 1),
  };
}

/** Why this runtime cannot generate maxGenerated frames per interval, or null when it can; a probe asks with 1. */
export function capabilityRefusal(capabilities: DlssgCapabilities, maxGenerated: number): { reason: DlssgRefusal; detail: string } | null {
  if (capabilities.needsUpdatedDriver) {
    return { reason: "driverTooOld", detail: `the NVIDIA driver is too old for this nvngx_dlssg.dll. Install driver ${capabilities.minDriverVersion ?? "a newer version"} or later.` };
  }
  if (!capabilities.available) {
    const initResult = capabilities.featureInitResult === null ? "" : ` (FeatureInitResult ${ngxName(capabilities.featureInitResult)})`;
    return { reason: "unsupported", detail: `the runtime reports it unavailable on this GPU and driver${initResult}. Update the NVIDIA driver, or run on a GPU the runtime supports.` };
  }
  if (maxGenerated > capabilities.multiFrameCountMax) {
    const most = capabilities.multiFrameCountMax;
    return { reason: "tooManyGenerated", detail: `this nvngx_dlssg.dll generates at most ${most} frame(s) per interval (${most + 1}x) and ${maxGenerated} were requested. Ask for ${most + 1}x or less.` };
  }
  return null;
}

function setCreateParameters(params: NgxParameters, options: DlssgFeatureOptions): void {
  // 0 also creates on 310.9.1, but logs a warning for every allocation.
  params.setU32(NgxParam.CreationNodeMask, 1);
  params.setU32(NgxParam.VisibilityNodeMask, 1);
  params.setU32(NgxParam.Width, options.width);
  params.setU32(NgxParam.Height, options.height);
  params.setU32(DlssgCreateParam.Width, options.width);
  params.setU32(DlssgCreateParam.Height, options.height);
  params.setU32(DlssgCreateParam.BackbufferFormat, DXGI_FORMAT_R8G8B8A8_UNORM);
  params.setU32(DlssgCreateParam.InternalWidth, options.width);
  params.setU32(DlssgCreateParam.InternalHeight, options.height);
  params.setU32(DlssgCreateParam.DynamicResolution, 0);
  params.setU32(DlssgCreateParam.UserInterfaceRecompositionEnabled, 0);
}

function createIntervalResources(device: D3D12Device, options: DlssgFeatureOptions): IntervalResources {
  const created: D3D12Resource[] = [];
  const keep = (resource: D3D12Resource): D3D12Resource => {
    created.push(resource);
    return resource;
  };
  const size = { width: options.width, height: options.height };
  try {
    return {
      backbuffer: keep(device.createTexture2D({ ...size, format: DXGI_FORMAT_R8G8B8A8_UNORM, label: "dlssg backbuffer" })),
      motion: keep(device.createTexture2D({ ...size, format: DXGI_FORMAT_R16G16_FLOAT, label: "dlssg motion" })),
      // A plain R32_FLOAT colour texture is accepted as depth (measured on 310.9.1), so no depth-stencil resource is needed.
      depth: keep(device.createTexture2D({ ...size, format: DXGI_FORMAT_R32_FLOAT, label: "dlssg depth" })),
      outputs: Array.from({ length: options.maxGenerated }, (_, index) =>
        keep(device.createTexture2D({ ...size, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: `dlssg output ${index + 1}` })),
      ),
      disableFlags: Array.from({ length: options.maxGenerated }, (_, index) =>
        keep(device.createUnorderedAccessBuffer(DISABLE_FLAG_BUFFER_BYTES, `dlssg disable flag ${index + 1}`)),
      ),
    };
  } catch (error) {
    for (const resource of created) resource.release();
    throw error;
  }
}

function releaseIntervalResources(resources: IntervalResources): void {
  for (const resource of [resources.backbuffer, resources.motion, resources.depth, ...resources.outputs, ...resources.disableFlags]) resource.release();
}

function planeDepthPixels(options: DlssgFeatureOptions, constants: DlssgIntervalConstants): Uint8Array {
  const depth = new Float32Array(options.width * options.height).fill(constants.planeDepth);
  return new Uint8Array(depth.buffer);
}

/**
 * Submits whatever is recorded, so none of it runs later on the session's list. False when the
 * GPU did not finish: what the recorded work uses must then stay allocated.
 */
function drainList(session: GpuSession): boolean {
  try {
    session.gpu.submitAndWait();
    return true;
  } catch {
    return false;
  }
}

export class DlssgFeature {
  private closed = false;
  /** Source frame of an interval that failed after some of its evaluates were recorded. */
  private brokenAtFrame: number | null = null;

  private constructor(
    private readonly session: GpuSession,
    private readonly core: NgxCore,
    private readonly params: NgxParameters,
    private readonly handle: number,
    readonly capabilities: DlssgCapabilities,
    readonly maxGenerated: number,
    private readonly resources: IntervalResources,
    // The matrices are bound by pointer, so they must outlive every evaluate.
    private readonly constants: DlssgIntervalConstants,
    private readonly forwarderKeep: unknown,
  ) {}

  /** What the runtime reports, without creating the feature: the answer to dlssg-host's --probe. Throws the NgxError of a failed Init_Ext. */
  static probe(session: GpuSession, options: DlssgRuntimeOptions): DlssgCapabilities {
    return readCapabilities(initCore(session, options).core);
  }

  /** Throws DlssgUnavailableError, carrying the runtime's capabilities, when the runtime cannot generate maxGenerated frames per interval. */
  static open(session: GpuSession, options: DlssgFeatureOptions): DlssgFeature {
    if (!Number.isInteger(options.maxGenerated) || options.maxGenerated < 1) {
      throw new Error(`DLSS Frame Generation: maxGenerated must be a whole number of frames, 1 or more; got ${options.maxGenerated}`);
    }
    const { core, forwarder } = initCore(session, options);
    const params = core.allocateParameters();
    let handle = 0;
    let resources: IntervalResources | null = null;
    try {
      if (NgxParameters.detectLayout(params) === "unknown") {
        throw new Error("DLSS Frame Generation: the NGX parameter object answers in neither known vtable layout, so no parameter can be set or read. Update the NVIDIA driver.");
      }
      const capabilities = readCapabilities(core);
      const refused = capabilityRefusal(capabilities, options.maxGenerated);
      if (refused) throw new DlssgUnavailableError(refused.reason, capabilities, refused.detail);

      setCreateParameters(params, options);
      const created = core.createFeature(session.gpu.list.ptr, NgxFeature.FrameGeneration, params);
      ngxCheck(created.result, "DLSS Frame Generation CreateFeature");
      handle = created.handle;
      session.gpu.submitAndWait();

      const constants = dlssgIntervalConstants(options);
      resources = createIntervalResources(session.device, options);
      session.gpu.uploadTexture(resources.depth, planeDepthPixels(options, constants), INPUT_STATE);
      session.gpu.submitAndWait();
      return new DlssgFeature(session, core, params, handle, capabilities, options.maxGenerated, resources, constants, forwarder);
    } catch (error) {
      // After a GPU timeout the feature and the resources may still be in use, so they are left allocated.
      if (drainList(session)) {
        if (resources) releaseIntervalResources(resources);
        if (handle !== 0) core.releaseFeature(handle);
      }
      core.destroyParameters(params);
      throw error;
    }
  }

  /**
   * Generate the frames between the previous source frame and this one. Throws
   * DlssgFeatureStaleError when the feature has to be recreated, and DlssgResetIgnoredError when
   * the runtime did not honour a reset.
   */
  interval(input: DlssgIntervalInput): DlssgIntervalResult {
    if (this.closed) throw new Error("DLSS Frame Generation: interval() after close()");
    if (this.brokenAtFrame !== null) {
      throw new DlssgFeatureStaleError(`the interval of source frame ${this.brokenAtFrame} failed after some of its evaluates were recorded, so the feature's history no longer matches the frames it was given`);
    }
    if (!Number.isInteger(input.generatedCount) || input.generatedCount < 1 || input.generatedCount > this.maxGenerated) {
      throw new Error(`DLSS Frame Generation: generatedCount must be a whole number from 1 to ${this.maxGenerated}, the maxGenerated this feature was opened with; got ${input.generatedCount}`);
    }
    const calls = intervalEvaluateCalls(input.generatedCount, input.reset);
    this.recordInterval(input, calls);
    const outputs = input.reset ? [] : this.resources.outputs.slice(0, calls.length);
    const readback = this.submitAndRead(outputs, input.frameId);
    switch (classifyInterval(readback.buffers[0]!, input.reset)) {
      case "generated":
        return { outcome: "generated", frames: readback.textures };
      case "disabled":
        return { outcome: "disabled" };
      case "reset":
        return { outcome: "reset" };
      case "resetIgnored":
        throw new DlssgResetIgnoredError(input.frameId);
      case "stale":
        throw new DlssgFeatureStaleError(`it evaluated source frame ${input.frameId} without error but wrote no result for it`);
    }
  }

  /** Submits the recorded interval and reads its outputs and first disable flag back. */
  private submitAndRead(outputs: D3D12Resource[], frameId: number): Readback {
    try {
      return this.session.gpu.readbackMany({ textures: outputs, buffers: [this.resources.disableFlags[0]!], textureRestoreState: UAV });
    } catch (error) {
      // Every evaluate of the interval was submitted, so the feature's history may already include it.
      this.brokenAtFrame = frameId;
      throw error;
    }
  }

  /** Records the uploads and every evaluate of one interval; on failure submits what was recorded so the next interval starts from an empty list. */
  private recordInterval(input: DlssgIntervalInput, calls: EvaluateCall[]): void {
    const gpu = this.session.gpu;
    let evaluated = 0;
    try {
      gpu.uploadTexture(this.resources.backbuffer, input.rgba, INPUT_STATE);
      gpu.uploadTexture(this.resources.motion, input.motion, INPUT_STATE);
      const flags = this.resources.disableFlags.slice(0, calls.length);
      gpu.fillBuffers({ buffers: flags, byteValue: DISABLE_FLAG_UNWRITTEN, finalState: UAV });
      this.bindIntervalParameters(input.frameId);
      for (const [index, call] of calls.entries()) {
        this.recordEvaluate(call, this.resources.outputs[index]!, flags[index]!);
        evaluated++;
      }
    } catch (error) {
      // The submitted list declares more indices than it evaluates, the shape intervalEvaluateCalls
      // rules out for resets because it corrupts the feature's history.
      if (evaluated > 0) this.brokenAtFrame = input.frameId;
      drainList(this.session);
      throw error;
    }
  }

  /** Everything the calls of one interval share. The runtime reads the inputs at MultiFrameIndex 1 only (measured on 310.9.1). */
  private bindIntervalParameters(frameId: number): void {
    const params = this.params;
    params.setResource(DlssgEvaluateParam.Backbuffer, this.resources.backbuffer.ptr);
    params.setResource(DlssgEvaluateParam.MVecs, this.resources.motion.ptr);
    params.setResource(DlssgEvaluateParam.Depth, this.resources.depth.ptr);
    for (const unused of [DlssgEvaluateParam.HUDLess, DlssgEvaluateParam.UI, DlssgEvaluateParam.UIAlpha, DlssgEvaluateParam.BidirectionalDistortionField, DlssgEvaluateParam.OutputReal]) {
      params.setResource(unused, 0);
    }
    const constants = this.constants;
    params.setPointer(DlssgEvaluateParam.CameraViewToClip, asPtr(ptr(constants.cameraViewToClip)));
    params.setPointer(DlssgEvaluateParam.ClipToCameraView, asPtr(ptr(constants.clipToCameraView)));
    params.setPointer(DlssgEvaluateParam.ClipToPrevClip, asPtr(ptr(constants.clipToPrevClip)));
    params.setPointer(DlssgEvaluateParam.PrevClipToClip, asPtr(ptr(constants.prevClipToClip)));
    params.setPointer(DlssgEvaluateParam.ClipToLensClip, asPtr(ptr(constants.clipToLensClip)));
    // The motion field is already in pixels.
    params.setF32(DlssgEvaluateParam.MvecScaleX, 1);
    params.setF32(DlssgEvaluateParam.MvecScaleY, 1);
    params.setU32(DlssgEvaluateParam.DepthInverted, 0);
    params.setU64(DlssgEvaluateParam.BackbufferFrameID, frameId);
  }

  private recordEvaluate(call: EvaluateCall, output: D3D12Resource, disableFlag: D3D12Resource): void {
    const params = this.params;
    this.session.gpu.list.transition(output, UAV);
    params.setResource(DlssgEvaluateParam.OutputInterpolated, output.ptr);
    params.setResource(DlssgEvaluateParam.OutputDisableInterpolation, disableFlag.ptr);
    params.setU32(DlssgEvaluateParam.MultiFrameCount, call.multiFrameCount);
    params.setU32(DlssgEvaluateParam.MultiFrameIndex, call.multiFrameIndex);
    params.setU32(DlssgEvaluateParam.Reset, call.reset ? 1 : 0);
    ngxCheck(
      this.core.evaluateFeature(this.session.gpu.list.ptr, this.handle, params),
      `DLSS Frame Generation EvaluateFeature (MultiFrameIndex ${call.multiFrameIndex} of ${call.multiFrameCount})`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A submit whose wait timed out may still be running the feature on these resources, so they are
    // left to the process exit, as open() leaves them after a timeout.
    if (!this.session.gpu.idle) return;
    this.core.releaseFeature(this.handle);
    this.core.destroyParameters(this.params);
    releaseIntervalResources(this.resources);
    void this.forwarderKeep;
    // Deliberately no Shutdown1: this driver core faults on it after a create (core.ts).
  }
}
