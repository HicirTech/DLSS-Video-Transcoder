/**
 * The neural frame engine, registered with the pipeline's engine factory.
 *
 * Importing this module (as the worker does when a job's engine is "nr") wires a
 * DLSS-backed engine into `createEngine`. It currently drives DLSS Super
 * Resolution (NGX feature 1) at DLAA — same input and output size, so it fits
 * the pipeline's 1:1 working-size contract while giving neural anti-aliasing and
 * detail recovery. True upscaling is exposed separately through the `sr` CLI and
 * the SR session's render/output split; feature 18 neural rendering plugs in
 * behind this same interface once its create contract is solved.
 */
import { RUNTIME_DIR } from "../paths.ts";
import { registerNeuralEngine, type Engine, type EngineOptions } from "../pipeline/engine.ts";
import type { GpuSession } from "../pipeline/gpu.ts";
import { PerfQuality } from "./results.ts";
import { DlssSrSession } from "./sr.ts";

class NeuralEngine implements Engine {
  readonly name = "nr";
  readonly outputWidth: number;
  readonly outputHeight: number;
  private readonly sr: DlssSrSession;
  private closed = false;

  constructor(
    session: GpuSession,
    readonly width: number,
    readonly height: number,
    options: EngineOptions,
  ) {
    this.outputWidth = width;
    this.outputHeight = height;
    this.sr = DlssSrSession.open(session, {
      renderWidth: width,
      renderHeight: height,
      outputWidth: width,
      outputHeight: height,
      quality: PerfQuality.DLAA,
      runtimeDir: options.runtimeDir ?? RUNTIME_DIR,
      appDataPath: options.appDataPath,
    });
  }

  process(frame: { rgba: Uint8Array; reset: boolean; motion: Float32Array | null }): Uint8Array {
    return this.sr.evaluate(frame.rgba, frame.reset, frame.motion);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sr.close();
  }
}

registerNeuralEngine((_kind, session, options) => new NeuralEngine(session, options.width, options.height, options));
