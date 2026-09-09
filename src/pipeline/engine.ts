/**
 * The frame engine contract (RGBA8 in, RGBA8 out) plus the factory registry the
 * NGX engines register themselves into.
 *
 * `BypassEngine` round-trips a frame through GPU memory unchanged, so decode,
 * upload, readback, encode and muxing can be verified without a neural runtime
 * and a neural result has an untouched pass to be compared against.
 */
import {
  D3D12_RESOURCE_STATE_COPY_DEST,
  D3D12_RESOURCE_STATE_COPY_SOURCE,
  D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
  DXGI_FORMAT_R8G8B8A8_UNORM,
  type D3D12Resource,
} from "../native/d3d12.ts";
import type { EngineKind, NrSettings } from "../server/api-types.ts";
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
  readonly width: number;
  readonly height: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  process(frame: FrameInput): Uint8Array;
  close(): void;
}

export interface EngineOptions {
  width: number;
  height: number;
  settings: NrSettings;
  /** Output size for an upscaling engine (sr); defaults to width/height (1:1) when omitted. */
  outputWidth?: number;
  outputHeight?: number;
  /** Folder with user-supplied NVIDIA runtime DLLs (neural engine only). */
  runtimeDir?: string;
  /** Specific DLSS DLL folder to load (version switching); defaults to the runtime feature folder. */
  dllDir?: string;
  appDataPath?: string;
}

export class BypassEngine implements Engine {
  readonly name = "bypass";
  readonly outputWidth: number;
  readonly outputHeight: number;
  private readonly source: D3D12Resource;
  private readonly target: D3D12Resource;
  private closed = false;

  constructor(
    private readonly session: GpuSession,
    readonly width: number,
    readonly height: number,
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

export type EngineFactory = (kind: EngineKind, session: GpuSession, options: EngineOptions) => Engine;

let neuralFactory: EngineFactory | null = null;
let srFactory: EngineFactory | null = null;

/** The neural (feature 18) engine registers itself here so this module does not import NGX code. */
export function registerNeuralEngine(factory: EngineFactory): void {
  neuralFactory = factory;
}

/** The DLSS Super Resolution engine registers itself here, for the same reason. */
export function registerSrEngine(factory: EngineFactory): void {
  srFactory = factory;
}

export function createEngine(kind: EngineKind, session: GpuSession, options: EngineOptions): Engine {
  switch (kind) {
    case "bypass":
      return new BypassEngine(session, options.width, options.height);
    case "nr":
      if (!neuralFactory) throw new Error("Neural engine is not registered; import src/ngx/nr.ts before creating it");
      return neuralFactory(kind, session, options);
    case "sr":
      if (!srFactory) throw new Error("SR engine is not registered; import src/ngx/sr-engine.ts before creating it");
      return srFactory(kind, session, options);
    default:
      throw new Error(`Unknown engine "${String(kind)}". Choose "sr" (DLSS Super Resolution), "nr" (DLSS Neural Rendering) or "bypass" (plain copy).`);
  }
}
