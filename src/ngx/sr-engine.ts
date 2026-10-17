/**
 * DLSS Super Resolution frame engine: importing this module (engine-loader.ts does,
 * for a job that runs Super Resolution) wires NGX feature 1 into `createEngineChain`.
 *
 * This is the one engine whose output size differs from its input. The output
 * size is the job's own; only the DLSS quality mode is the one whose ratio is
 * nearest (qualityForSizes), as for the sr command.
 */
import { RUNTIME_DIR } from "../paths.ts";
import { registerSrEngine, type Engine, type SrEngineOptions } from "../pipeline/engine.ts";
import type { GpuSession } from "../pipeline/gpu.ts";
import { qualityForSizes } from "./results.ts";
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
    options: SrEngineOptions,
  ) {
    this.outputWidth = options.outputWidth;
    this.outputHeight = options.outputHeight;
    this.sr = DlssSrSession.open(session, {
      renderWidth: width,
      renderHeight: height,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      quality: qualityForSizes(width, this.outputWidth),
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

registerSrEngine((session, options) => new SrEngine(session, options.width, options.height, options));
