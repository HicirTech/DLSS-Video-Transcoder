/**
 * The neural frame engine: importing this module (as the worker does when a job's
 * engine is "nr") wires DLSS Neural Rendering — NGX feature 18 — into
 * `createEngine`.
 *
 * Feature 18 enhances each frame at the same size, which is what lets it satisfy
 * the pipeline's 1:1 working-size contract; true DLSS upscaling with a
 * render/output split is a separate engine, `sr`.
 */
import { RUNTIME_DIR } from "../paths.ts";
import { registerNeuralEngine, type Engine, type EngineOptions } from "../pipeline/engine.ts";
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
    options: EngineOptions,
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

registerNeuralEngine((_kind, session, options) => new NeuralEngine(session, options.width, options.height, options));
