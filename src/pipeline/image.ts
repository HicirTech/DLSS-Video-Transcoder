/**
 * Single-image job: PNG in, engine, PNG out.
 */
import { basename, dirname, extname, join } from "node:path";
import { decodePng, encodePng, isPng } from "../codec/png.ts";
import type { EngineKind, NrSettings, ScaleSettings } from "../server/api-types.ts";
import { createEngine } from "./engine.ts";
import { openGpu } from "./gpu.ts";
import { evenSize, resizeRgba } from "./resize.ts";

export interface ImageJobOptions {
  input: string;
  output?: string;
  engine: EngineKind;
  scale: ScaleSettings;
  settings: NrSettings;
  adapterIndex?: number;
  debugLayer?: boolean;
  runtimeDir?: string;
  appDataPath?: string;
  onProgress?: (fraction: number, message: string) => void;
}

export interface ImageJobResult {
  output: string;
  inputWidth: number;
  inputHeight: number;
  width: number;
  height: number;
  engine: EngineKind;
  passes: number;
  ms: number;
}

export function resolveTargetSize(width: number, height: number, scale: ScaleSettings): { width: number; height: number } {
  switch (scale.mode) {
    case "factor":
      return { width: evenSize(width * scale.factor), height: evenSize(height * scale.factor) };
    case "size":
      return { width: evenSize(scale.width), height: evenSize(scale.height) };
    default:
      return { width, height };
  }
}

export function defaultOutputPath(input: string, engine: EngineKind, extension = ".png"): string {
  const ext = extname(input);
  const stem = basename(input, ext);
  return join(dirname(input), `${stem}.${engine}${extension}`);
}

export async function processImage(options: ImageJobOptions): Promise<ImageJobResult> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => {});
  progress(0, "reading input");
  const bytes = new Uint8Array(await Bun.file(options.input).arrayBuffer());
  if (!isPng(bytes)) throw new Error(`${options.input}: only PNG input is supported by the image job for now`);
  const decoded = decodePng(bytes);
  const target = resolveTargetSize(decoded.width, decoded.height, options.scale);
  progress(0.1, `decoded ${decoded.width}x${decoded.height}, working size ${target.width}x${target.height}`);
  const working = resizeRgba(decoded.rgba, decoded.width, decoded.height, target.width, target.height);

  const session = openGpu({ adapterIndex: options.adapterIndex, debugLayer: options.debugLayer });
  let passes = 0;
  let result: Uint8Array;
  try {
    const engine = createEngine(options.engine, session, {
      width: target.width,
      height: target.height,
      settings: options.settings,
      runtimeDir: options.runtimeDir,
      appDataPath: options.appDataPath,
    });
    try {
      // A still image has no history; run extra passes so temporal state settles.
      const total = options.engine === "nr" ? Math.max(1, options.settings.warmupFrames + 1) : 1;
      result = working;
      for (let i = 0; i < total; i++) {
        result = engine.process({ rgba: working, reset: i === 0, motion: null });
        passes++;
        progress(0.1 + (0.8 * passes) / total, `pass ${passes}/${total} on ${engine.name}`);
      }
      if (engine.outputWidth !== target.width || engine.outputHeight !== target.height) {
        target.width = engine.outputWidth;
        target.height = engine.outputHeight;
      }
    } finally {
      engine.close();
    }
  } finally {
    session.close();
  }

  progress(0.92, "encoding PNG");
  const output = options.output ?? defaultOutputPath(options.input, options.engine);
  await Bun.write(output, encodePng({ width: target.width, height: target.height, rgba: result }, { level: 6 }));
  progress(1, "done");
  return {
    output,
    inputWidth: decoded.width,
    inputHeight: decoded.height,
    width: target.width,
    height: target.height,
    engine: options.engine,
    passes,
    ms: Math.round(performance.now() - started),
  };
}
