/**
 * The neural frame engine, registered with the pipeline's engine factory.
 *
 * Importing this module (as the worker does when a job's engine is "nr") wires
 * **DLSS Neural Rendering — NGX feature 18** (`DlssNrSession`) into `createEngine`.
 * This is the real feature-18 path: it enhances each frame at the same size (no
 * upscale, so it fits the pipeline's 1:1 working-size contract) and honours the
 * `NrSettings` look controls (preset at create; intensity / local tone / local
 * structure / skin structure / style / auto-mask / UI-correction per evaluate).
 *
 * Feature 18 as implemented does not consume motion vectors, so the pipeline's
 * optical-flow motion is ignored here; `reset` still clears temporal history on
 * the first frame and scene cuts. True DLSS upscaling (render/output split) is a
 * separate concern exposed through the `sr` CLI / SR engine.
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
      appDataPath: options.appDataPath,
    });
  }

  process(frame: { rgba: Uint8Array; reset: boolean; motion: Float32Array | null }): Uint8Array {
    // Feature 18 does not take motion vectors; only the reset flag is used.
    return this.nr.evaluate(frame.rgba, frame.reset);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.nr.close();
  }
}

registerNeuralEngine((_kind, session, options) => new NeuralEngine(session, options.width, options.height, options));
