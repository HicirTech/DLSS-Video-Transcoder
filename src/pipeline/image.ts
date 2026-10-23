/**
 * Single-image job: PNG in, the job's engine chain (Super Resolution, then Neural Rendering), PNG out.
 */
import { isPng } from "../codec/png/chunks.ts";
import { decodePng } from "../codec/png/decode.ts";
import { encodePng } from "../codec/png/encode.ts";
import type { RgbaImage } from "../codec/png/types.ts";
import { DEFAULT_SCALE_SETTINGS, DEFAULT_WARMUP_FRAMES, jobSteps, type NeuralRenderingStep, type ScaleSettings, type StepKind, stepsSuffix, type SuperResolutionStep } from "../server/api-types.ts";
import { resolveTargetSize, srOutputProblem } from "../server/output-size.ts";
import { throwIfAbortedAfterYield } from "./cancel.ts";
import { createEngineChain } from "./engine.ts";
import type { ProgressReporter } from "./frame-progress.ts";
import { describeGpu, openGpu } from "./gpu.ts";
import { defaultOutputPath } from "./output-path.ts";
import { resizePlane, resizeRgba } from "./resize.ts";

export interface ImageJobOptions {
  input: string;
  output?: string;
  superResolution?: SuperResolutionStep;
  neuralRendering?: NeuralRenderingStep;
  /** A resize of the decoded still; only without superResolution, which sets the size itself. */
  resize?: ScaleSettings;
  /** Passes over the still before the kept one; default DEFAULT_WARMUP_FRAMES. */
  warmupFrames?: number;
  /** One of the two, never both: see GpuOptions. */
  adapterIndex?: number;
  adapterUuid?: string;
  debugLayer?: boolean;
  runtimeDir?: string;
  appDataPath?: string;
  /** The still's `frames` are the engine passes it runs: the warm-up frames and the one that is kept. */
  onProgress?: ProgressReporter;
  /** Cooperative cancellation (see cancel.ts): checked before the GPU is opened and before every pass; nothing is written until the passes are done. */
  signal?: AbortSignal;
  /** Called once as the run starts finishing; see VideoJobOptions.onFinishing. */
  onFinishing?: () => void;
}

export interface ImageJobResult {
  output: string;
  inputWidth: number;
  inputHeight: number;
  width: number;
  height: number;
  /** The steps that ran, in order. */
  steps: StepKind[];
  passes: number;
  ms: number;
}

/**
 * The alpha plane of an RGBA8 frame, and a copy of the frame with alpha forced
 * to 255; the inverse is attachAlpha. `rgba` is not modified. Why a still is
 * split around the neural engines is enhanceStill's to say.
 */
export function splitAlpha(rgba: Uint8Array): { colour: Uint8Array; alpha: Uint8Array } {
  const pixels = rgba.byteLength >> 2;
  const colour = new Uint8Array(rgba);
  const alpha = new Uint8Array(pixels);
  for (let i = 0, a = 3; i < pixels; i++, a += 4) {
    alpha[i] = rgba[a]!;
    colour[a] = 255;
  }
  return { colour, alpha };
}

/** Write `alpha` (one byte per pixel, the frame's own size) into the alpha channel of `rgba`, in place. */
export function attachAlpha(rgba: Uint8Array, alpha: Uint8Array): void {
  if (rgba.byteLength !== alpha.byteLength * 4) {
    throw new Error(`attachAlpha: ${alpha.byteLength} alpha bytes do not match ${rgba.byteLength} RGBA bytes`);
  }
  for (let i = 0, a = 3; i < alpha.byteLength; i++, a += 4) rgba[a] = alpha[i]!;
}

/**
 * Run a still through `enhance` on its colour only, then hand the source alpha
 * back at the output's size. The neural engines are defined on colour: DLSS SR
 * resamples a fourth channel like colour and feature 18 writes 255 into it
 * (both measured on a soft-edged alpha), so alpha never enters the network and
 * is resized with the same bilinear kernel the colour path uses — at 1:1 it is
 * the source alpha byte for byte. Every still path (processImage, the sr and nr
 * commands) goes through here so the rule has one owner. `enhance` receives the
 * colour with alpha 255 and returns the output frame, which is modified in place.
 */
export async function enhanceStill(source: RgbaImage, enhance: (colour: Uint8Array) => RgbaImage | Promise<RgbaImage>): Promise<RgbaImage> {
  const { colour, alpha } = splitAlpha(source.rgba);
  const out = await enhance(colour);
  attachAlpha(out.rgba, resizePlane(alpha, source, out));
  return out;
}

/**
 * A still's passes through an engine: a still has no history, so the first pass
 * resets it and `warmupFrames` more feed the same frame again until the temporal
 * state of SR and NR settles; an engine that keeps none (`temporal` false, the
 * copy a job without steps runs) runs once. Image jobs and the sr and nr commands
 * all go through here. Returns the last pass's output.
 */
export async function runStillPasses(temporal: boolean, warmupFrames: number, pass: (reset: boolean, total: number) => Uint8Array | Promise<Uint8Array>): Promise<Uint8Array> {
  const total = temporal ? Math.max(1, warmupFrames + 1) : 1;
  let output = await pass(true, total);
  for (let index = 1; index < total; index++) output = await pass(false, total);
  return output;
}

export async function processImage(options: ImageJobOptions): Promise<ImageJobResult> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  progress(0, "reading input");
  const bytes = new Uint8Array(await Bun.file(options.input).arrayBuffer());
  if (!isPng(bytes)) throw new Error(`${options.input}: image jobs currently accept PNG input only. Convert the file to PNG and try again.`);
  const decoded = decodePng(bytes);
  const sr = options.superResolution;
  const target = resolveTargetSize(decoded.width, decoded.height, sr?.scale ?? options.resize ?? DEFAULT_SCALE_SETTINGS);
  // SR's limits need the source size, so they are checked here, before the GPU opens.
  const srProblem = sr ? srOutputProblem(decoded, target) : null;
  if (srProblem) throw new Error(srProblem);
  const steps = jobSteps({ superResolution: sr, neuralRendering: options.neuralRendering });
  // The SR engine upscales inside DLSS, so feed it the source frame and let it
  // write the larger output. Without SR the frame is resized to the target first.
  const upscaling = sr !== undefined;
  const renderWidth = upscaling ? decoded.width : target.width;
  const renderHeight = upscaling ? decoded.height : target.height;
  progress(
    0.1,
    `decoded ${decoded.width}x${decoded.height}, ${upscaling ? `upscaling to ${target.width}x${target.height}` : `working size ${target.width}x${target.height}`}`,
  );
  await throwIfAbortedAfterYield(options.signal);
  const session = openGpu({ adapterIndex: options.adapterIndex, adapterUuid: options.adapterUuid, debugLayer: options.debugLayer });
  progress(0.1, describeGpu(session));
  let passes = 0;
  let result: RgbaImage;
  try {
    const engine = createEngineChain(session, {
      width: renderWidth,
      height: renderHeight,
      outputWidth: target.width,
      outputHeight: target.height,
      superResolution: sr,
      neuralRendering: options.neuralRendering,
      runtimeDir: options.runtimeDir,
      appDataPath: options.appDataPath,
    });
    try {
      result = await enhanceStill(decoded, async (colour) => {
        const working = upscaling ? colour : resizeRgba(colour, decoded, target);
        const rgba = await runStillPasses(steps.length > 0, options.warmupFrames ?? DEFAULT_WARMUP_FRAMES, async (reset, total) => {
          // Each pass is synchronous FFI and never yields on its own.
          await throwIfAbortedAfterYield(options.signal);
          const output = engine.process({ rgba: working, reset, motion: null });
          passes++;
          progress(0.1 + (0.8 * passes) / total, `pass ${passes}/${total} on ${engine.name}`, { done: passes, total });
          return output;
        });
        return { rgba, width: engine.outputWidth, height: engine.outputHeight };
      });
    } finally {
      engine.close();
    }
  } finally {
    session.close();
  }

  options.onFinishing?.();
  progress(0.92, "encoding PNG");
  const resized = !sr && options.resize !== undefined && options.resize.mode !== "none";
  const output = options.output ?? defaultOutputPath(options.input, stepsSuffix(steps, resized), ".png");
  await Bun.write(output, encodePng(result, { level: 6 }));
  progress(1, "done");
  return {
    output,
    inputWidth: decoded.width,
    inputHeight: decoded.height,
    width: result.width,
    height: result.height,
    steps,
    passes,
    ms: Math.round(performance.now() - started),
  };
}
