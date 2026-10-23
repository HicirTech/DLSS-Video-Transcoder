/**
 * The frames a frame generation job interpolates when it also runs Super Resolution or Neural Rendering: each
 * decoded frame goes through the job's engine chain first, on the GPU the job chose, and is handed on in shared
 * memory, which frame generation's worker threads read without a copy.
 */
import type { NeuralRenderingStep, SuperResolutionStep } from "../server/api-types.ts";
import { createEngineChain, type Engine } from "./engine.ts";
import { createFrameGuide, type FrameGuide } from "./frame-guide.ts";
import type { ProgressReporter } from "./frame-progress.ts";
import { allocateFrame, type FrameReader, type FrameSource } from "./frame-reader.ts";
import { describeGpu, openGpu, type GpuSelection, type GpuSession } from "./gpu.ts";

/** The GPU selection names where the chain runs; frame generation's host picks its own. */
export interface ProcessedFramesOptions extends GpuSelection {
  /** The decoded frames, at the decode size. */
  reader: FrameReader;
  /** The decode size: the source's when Super Resolution runs, else the output size. */
  decodeWidth: number;
  decodeHeight: number;
  /** The size frame generation runs at, which Super Resolution upscales to. */
  outputWidth: number;
  outputHeight: number;
  superResolution?: SuperResolutionStep;
  neuralRendering?: NeuralRenderingStep;
  runtimeDir: string;
  appDataPath?: string;
  progress: ProgressReporter;
}

export class ProcessedFrames implements FrameSource {
  private index = 0;
  private closed = false;

  private constructor(
    private readonly reader: FrameReader,
    private readonly decodeBytes: number,
    private readonly session: GpuSession,
    private readonly chain: Engine,
    private readonly frameGuide: FrameGuide,
  ) {}

  /**
   * Opens a GPU session, the engine chain and its guide, with the engines already loaded (engine-loader.ts). On a
   * failure here, whatever was opened is closed again.
   */
  static open(options: ProcessedFramesOptions): ProcessedFrames {
    const sr = options.superResolution;
    const session = openGpu({ adapterIndex: options.adapterIndex, adapterUuid: options.adapterUuid });
    options.progress(0, `${describeGpu(session)}, for the steps before frame generation, whose host picks its own GPU`);
    let chain: Engine | null = null;
    try {
      chain = createEngineChain(session, {
        width: options.decodeWidth,
        height: options.decodeHeight,
        outputWidth: options.outputWidth,
        outputHeight: options.outputHeight,
        superResolution: sr,
        neuralRendering: options.neuralRendering,
        runtimeDir: options.runtimeDir,
        appDataPath: options.appDataPath,
      });
      const frameGuide = createFrameGuide(options.decodeWidth, options.decodeHeight, { flow: sr?.motion === "flow", cudaOrdinal: session.cudaOrdinal, progress: options.progress });
      return new ProcessedFrames(options.reader, options.decodeWidth * options.decodeHeight * 4, session, chain, frameGuide);
    } catch (error) {
      chain?.close();
      session.close();
      throw error;
    }
  }

  async next(frameBytes: number): Promise<Uint8Array | null> {
    const decoded = await this.reader.next(this.decodeBytes);
    // A read still in flight when a failed job closed this source: the engines are gone, so the frame goes nowhere.
    if (!decoded || this.closed) return null;
    const guidance = this.frameGuide.guide(decoded, this.index++);
    const processed = this.chain.process({ rgba: decoded, reset: guidance.reset, motion: guidance.motion });
    if (processed.byteLength !== frameBytes) throw new Error(`The engine chain wrote ${processed.byteLength} bytes per frame; frame generation expects ${frameBytes}.`);
    const frame = allocateFrame(frameBytes, true);
    frame.set(processed);
    return frame;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.frameGuide.close();
      this.chain.close();
    } finally {
      this.session.close();
    }
  }
}
