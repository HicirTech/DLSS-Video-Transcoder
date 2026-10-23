/**
 * The output size a job writes: its scale setting applied to the source and rounded to even, and the limits
 * DLSS Super Resolution and the NVENC encoders put on it. It imports no Node module, so the web can bundle the
 * same rule the pipeline and the NGX layer apply.
 */
import { DLSS_SR_MAX_OUTPUT_SIDE, type EncodeSettings, NVENC_MAX_SIDE, SR_FACTOR_MIN, type ScaleSettings } from "./api-types.ts";

/** Nearest even value, at least 2: 4:2:0 chroma subsampling cannot encode an odd dimension. */
export function evenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** The size `scale` gives a `width`x`height` source; mode none keeps the source's, odd sides included. */
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

/** The size a video job writes: resolveTargetSize rounded to even on both sides, since every encoder here writes 4:2:0. */
export function videoTargetSize(source: { width: number; height: number }, scale: ScaleSettings): { width: number; height: number } {
  const target = resolveTargetSize(source.width, source.height, scale);
  return { width: evenSize(target.width), height: evenSize(target.height) };
}

/**
 * Why DLSS SR cannot write `output` from a `render`-sized source, or null when it can: it
 * only enlarges (SR_FACTOR_MIN), and writes no side longer than DLSS_SR_MAX_OUTPUT_SIDE.
 */
export function srOutputProblem(render: { width: number; height: number }, output: { width: number; height: number }): string | null {
  if (output.width < render.width || output.height < render.height) {
    return `DLSS Super Resolution only enlarges: ${output.width}x${output.height} is smaller than the ${render.width}x${render.height} source. Use a factor of at least ${SR_FACTOR_MIN} (1 runs DLAA at the source size).`;
  }
  if (Math.max(output.width, output.height) > DLSS_SR_MAX_OUTPUT_SIDE) {
    return `DLSS Super Resolution writes at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side; ${output.width}x${output.height} is larger. Use a smaller factor or output size.`;
  }
  return null;
}

/**
 * The longest side `codec`'s NVENC encoder takes (NVENC_MAX_SIDE) when `size` is larger than that, else null: such
 * an output encodes with the codec's CPU sibling instead. A CPU codec has no such limit.
 */
export function nvencLimitExceeded(codec: EncodeSettings["codec"], size: { width: number; height: number }): number | null {
  const limit = NVENC_MAX_SIDE[codec];
  return limit !== undefined && Math.max(size.width, size.height) > limit ? limit : null;
}

/** What output size a step can write, beyond the API's own ranges (SETTING_RANGES). */
export interface OutputSizeLimits {
  /** The smallest factor. */
  factorMin: number | null;
  /** The longest side, in pixels. */
  sideMax: number | null;
  /** The limits in words, for the form's hint; null when there are none. */
  note: string | null;
}

/** Super Resolution only enlarges and has a longest side (srOutputProblem); a resize takes the API's whole range. */
export function outputSizeLimits(by: "sr" | "resize"): OutputSizeLimits {
  if (by === "resize") return { factorMin: null, sideMax: null, note: null };
  return {
    factorMin: SR_FACTOR_MIN,
    sideMax: DLSS_SR_MAX_OUTPUT_SIDE,
    note: `Super Resolution only enlarges, from ${SR_FACTOR_MIN}× (DLAA at the source size), and writes at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side.`,
  };
}
