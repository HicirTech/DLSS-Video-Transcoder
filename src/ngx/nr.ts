/**
 * The neural frame engine: importing this module (engine-loader.ts does, for a job
 * that runs Neural Rendering) wires DLSS Neural Rendering — NGX feature 18 — into
 * `createEngineChain`.
 *
 * Feature 18 enhances each frame at the same size, so this engine's output size
 * is its input size; true DLSS upscaling with a render/output split is a
 * separate engine, `sr`, which runs before this one when a job has both steps.
 */
import { RUNTIME_DIR } from "../paths.ts";
import { registerNeuralEngine, type Engine, type NrEngineOptions } from "../pipeline/engine.ts";
import type { GpuSession } from "../pipeline/gpu.ts";
import { DlssNrSession } from "./nr-render.ts";

class NeuralEngine implements Engine {
  readonly name = "nr";
  readonly outputWidth: number;
  readonly outputHeight: number;
  private readonly nr: DlssNrSession;
  private closed = false;

  constructor(
    session: GpuSession,
    readonly width: number,
    readonly height: number,
    options: NrEngineOptions,
  ) {
    this.outputWidth = width;
    this.outputHeight = height;
    this.nr = DlssNrSession.open(session, {
      width,
      height,
      settings: options.settings,
      runtimeDir: options.runtimeDir ?? RUNTIME_DIR,
      dllDir: options.dllDir,
      appDataPath: options.appDataPath,
    });
  }

  process(frame: { rgba: Uint8Array; reset: boolean; motion: Float32Array | null }): Uint8Array {
    // Feature 18 consumes no motion vectors, so the pipeline's optical flow is
    // dropped here; `reset` still clears temporal history on cuts and frame 1.
    return this.nr.evaluate(frame.rgba, frame.reset);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.nr.close();
  }
}

registerNeuralEngine((session, options) => new NeuralEngine(session, options.width, options.height, options));
