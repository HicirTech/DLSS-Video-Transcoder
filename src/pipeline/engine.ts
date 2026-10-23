/**
 * The frame engine contract (RGBA8 in, RGBA8 out), the registry the NGX engines register themselves into,
 * and the chain a job's frames go through: Super Resolution, then Neural Rendering.
 *
 * `BypassEngine` round-trips a frame through GPU memory unchanged: a job without either step runs it, so
 * decode, upload, readback, encode and muxing are the same path, and a neural result has an untouched pass to
 * be compared against.
 */
import {
  D3D12_RESOURCE_STATE_COPY_DEST,
  D3D12_RESOURCE_STATE_COPY_SOURCE,
  D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
  DXGI_FORMAT_R8G8B8A8_UNORM,
  type D3D12Resource,
} from "../native/d3d12.ts";
import type { NeuralRenderingStep, NrSettings, SuperResolutionStep } from "../server/api-types.ts";
import type { GpuSession } from "./gpu.ts";

export interface FrameInput {
  /** Tightly packed RGBA8, width*height*4 bytes. */
  rgba: Uint8Array;
  /** True on the first frame and after scene cuts: clears temporal history. */
  reset: boolean;
  /** Per-pixel motion in pixels (x, y) at the engine's input size, or null for none. */
  motion: Float32Array | null;
}

export interface Engine {
  readonly name: string;
  readonly outputWidth: number;
  readonly outputHeight: number;
  process(frame: FrameInput): Uint8Array;
  close(): void;
}

/** Where an NGX engine loads its DLL from. */
interface EngineRuntime {
  /** Folder with user-supplied NVIDIA runtime DLLs. */
  runtimeDir?: string;
  /** Specific DLSS DLL folder to load (version switching); defaults to the runtime feature folder. */
  dllDir?: string;
  appDataPath?: string;
}

/** DLSS Super Resolution's engine: renders `width`x`height` frames to `outputWidth`x`outputHeight`. */
export interface SrEngineOptions extends EngineRuntime {
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
}

/** DLSS Neural Rendering's engine: enhances `width`x`height` frames at their size. */
export interface NrEngineOptions extends EngineRuntime {
  width: number;
  height: number;
  settings: NrSettings;
}

class BypassEngine implements Engine {
  readonly name = "bypass";
  readonly outputWidth: number;
  readonly outputHeight: number;
  private readonly source: D3D12Resource;
  private readonly target: D3D12Resource;
  private closed = false;

  constructor(
    private readonly session: GpuSession,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.outputWidth = width;
    this.outputHeight = height;
    this.source = session.device.createTexture2D({ width, height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "bypass source" });
    try {
      this.target = session.device.createTexture2D({ width, height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "bypass target" });
    } catch (error) {
      this.source.release(); // the constructor threw, so no instance exists and close() will never run
      throw error;
    }
  }

  process(frame: FrameInput): Uint8Array {
    if (this.closed) throw new Error("BypassEngine is closed");
    const expected = this.width * this.height * 4;
    if (frame.rgba.byteLength !== expected) throw new Error(`BypassEngine: expected ${expected} bytes, got ${frame.rgba.byteLength}`);
    const gpu = this.session.gpu;
    gpu.uploadTexture(this.source, frame.rgba, D3D12_RESOURCE_STATE_COPY_SOURCE);
    gpu.list.transition(this.target, D3D12_RESOURCE_STATE_COPY_DEST);
    gpu.list.copyResource(this.target, this.source);
    return gpu.readbackTexture(this.target, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.release();
    this.target.release();
  }
}

type SrEngineFactory = (session: GpuSession, options: SrEngineOptions) => Engine;
type NrEngineFactory = (session: GpuSession, options: NrEngineOptions) => Engine;

let neuralFactory: NrEngineFactory | null = null;
let srFactory: SrEngineFactory | null = null;

/** The neural (feature 18) engine registers itself here so this module does not import NGX code. */
export function registerNeuralEngine(factory: NrEngineFactory): void {
  neuralFactory = factory;
}

/** The DLSS Super Resolution engine registers itself here, for the same reason. */
export function registerSrEngine(factory: SrEngineFactory): void {
  srFactory = factory;
}

/** The per-frame steps a job runs on its decoded frames (JobRequest.superResolution and neuralRendering). */
export interface EngineChainOptions {
  /** The size of the frames the chain is fed: the source's when SR runs, else the decoded size. */
  width: number;
  height: number;
  /** The size Super Resolution writes; read only when it runs. */
  outputWidth: number;
  outputHeight: number;
  superResolution?: SuperResolutionStep;
  /** Runs after SR when both do, at SR's output size. */
  neuralRendering?: NeuralRenderingStep;
  runtimeDir?: string;
  appDataPath?: string;
}

/**
 * The engine a job's frames go through. One step opens just its own engine, so a job of one step runs the
 * same engine a one-engine job always ran; both open SR and then NR; neither opens BypassEngine.
 */
export function createEngineChain(session: GpuSession, options: EngineChainOptions): Engine {
  const runtime = { runtimeDir: options.runtimeDir, appDataPath: options.appDataPath };
  let sr: Engine | null = null;
  if (options.superResolution) {
    if (!srFactory) throw new Error("SR engine is not registered; load it through engine-loader.ts before creating it");
    sr = srFactory(session, { ...runtime, dllDir: options.superResolution.dllDir, width: options.width, height: options.height, outputWidth: options.outputWidth, outputHeight: options.outputHeight });
  }
  if (!options.neuralRendering) return sr ?? new BypassEngine(session, options.width, options.height);
  try {
    if (!neuralFactory) throw new Error("Neural engine is not registered; load it through engine-loader.ts before creating it");
    const nr = neuralFactory(session, { ...runtime, dllDir: options.neuralRendering.dllDir, width: sr?.outputWidth ?? options.width, height: sr?.outputHeight ?? options.height, settings: options.neuralRendering.settings });
    return sr ? new ChainEngine(sr, nr) : nr;
  } catch (error) {
    sr?.close(); // opened above, and nothing else holds it yet
    throw error;
  }
}

/** Super Resolution followed by Neural Rendering: NR enhances each frame SR has upscaled. */
class ChainEngine implements Engine {
  readonly name = "sr+nr";
  readonly outputWidth: number;
  readonly outputHeight: number;

  constructor(
    private readonly sr: Engine,
    private readonly nr: Engine,
  ) {
    this.outputWidth = nr.outputWidth;
    this.outputHeight = nr.outputHeight;
  }

  process(frame: FrameInput): Uint8Array {
    const upscaled = this.sr.process(frame);
    // NR takes no motion vectors; a scene cut clears its history as it clears SR's.
    return this.nr.process({ rgba: upscaled, reset: frame.reset, motion: null });
  }

  close(): void {
    try {
      this.sr.close();
    } finally {
      this.nr.close();
    }
  }
}
