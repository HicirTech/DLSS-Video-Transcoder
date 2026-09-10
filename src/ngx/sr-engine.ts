/**
 * DLSS Super Resolution frame engine: importing this module (as the worker does
 * when a job's engine is "sr") wires NGX feature 1 into `createEngine`.
 *
 * This is the one engine whose output size differs from its input. DLSS accepts
 * only a fixed set of render-to-output ratios, so the requested factor is snapped
 * to the nearest quality mode rather than honoured exactly.
 */
import { RUNTIME_DIR } from "../paths.ts";
import { registerSrEngine, type Engine, type EngineOptions } from "../pipeline/engine.ts";
import type { GpuSession } from "../pipeline/gpu.ts";
import { DlssRenderPreset, DLSS_RATIO, qualityForFactor } from "./results.ts";
import { DlssSrSession } from "./sr.ts";

class SrEngine implements Engine {
  readonly name = "sr";
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
    this.outputWidth = options.outputWidth ?? width;
    this.outputHeight = options.outputHeight ?? height;
    const factor = this.outputWidth / width;
    this.sr = DlssSrSession.open(session, {
      renderWidth: width,
      renderHeight: height,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      quality: qualityForFactor(factor),
      preset: DlssRenderPreset.L,
      runtimeDir: options.runtimeDir ?? RUNTIME_DIR,
      dllDir: options.dllDir,
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

registerSrEngine((_kind, session, options) => new SrEngine(session, options.width, options.height, options));
