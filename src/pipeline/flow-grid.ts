/** The small grayscale grid the flow is computed on: its size for a render size and the downscale onto it. */
import { luma } from "./scene-score.ts";

/** Longest side, in pixels, of the grid the flow is computed on (guides.py:21 calls it the flow width). */
export const MAX_FLOW_LONG_SIDE = 640;
/** Smallest flow-grid side: tiny sources are computed on a grid this large rather than their own size. */
export const MIN_FLOW_SIDE = 64;

/**
 * Flow-grid dimensions for a render size: the LONG side becomes ~MAX_FLOW_LONG_SIDE,
 * both dims even and >= MIN_FLOW_SIDE. Scaling by the long side rather than the
 * width keeps a portrait frame from running the flow on a far larger grid than
 * intended.
 */
export function flowGridSize(width: number, height: number): { flowW: number; flowH: number } {
  const scale = Math.min(1, MAX_FLOW_LONG_SIDE / Math.max(1, width, height));
  const flowW = Math.max(MIN_FLOW_SIDE, Math.round((width * scale) / 2) * 2);
  const flowH = Math.max(MIN_FLOW_SIDE, Math.round((height * scale) / 2) * 2);
  return { flowW, flowH };
}

/**
 * Box-average downscale RGBA8 -> Float32 luma at (flowW, flowH), reproducing
 * cvtColor(RGBA2GRAY) + resize(INTER_AREA).
 */
export function smallGray(rgba: Uint8Array, width: number, height: number, flowW: number, flowH: number): Float32Array {
  const out = new Float32Array(flowW * flowH);
  // Exact integer downscale — the usual case, e.g. 1280x720 -> 640x360. Every
  // output pixel averages the same sx*sy block, so the general path's
  // per-pixel divisions and bounds checks fall away. It sums the same source
  // pixels in the same order, so the two paths agree bit for bit.
  if (width % flowW === 0 && height % flowH === 0) {
    const sx = width / flowW;
    const sy = height / flowH;
    const n = sx * sy;
    for (let oy = 0; oy < flowH; oy++) {
      const yTop = oy * sy;
      for (let ox = 0; ox < flowW; ox++) out[oy * flowW + ox] = sumLumaBlock(rgba, width, ox * sx, yTop, sx, sy) / n;
    }
    return out;
  }
  for (let oy = 0; oy < flowH; oy++) {
    const y0 = Math.floor((oy * height) / flowH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / flowH));
    for (let ox = 0; ox < flowW; ox++) {
      const x0 = Math.floor((ox * width) / flowW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / flowW));
      out[oy * flowW + ox] = meanLumaInArea(rgba, width, height, x0, x1, y0, y1);
    }
  }
  return out;
}

/** Sum of the luma of the sx-by-sy pixel block whose top-left pixel is (xLeft, yTop). */
function sumLumaBlock(rgba: Uint8Array, width: number, xLeft: number, yTop: number, sx: number, sy: number): number {
  let sum = 0;
  for (let y = 0; y < sy; y++) {
    let base = ((yTop + y) * width + xLeft) * 4;
    for (let x = 0; x < sx; x++, base += 4) sum += luma(rgba[base]!, rgba[base + 1]!, rgba[base + 2]!);
  }
  return sum;
}

/** Mean luma of the pixels in [x0, x1) x [y0, y1) that lie inside the frame; 0 when none does. */
function meanLumaInArea(rgba: Uint8Array, width: number, height: number, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1 && y < height; y++) {
    let base = (y * width + x0) * 4;
    for (let x = x0; x < x1 && x < width; x++, base += 4) {
      sum += luma(rgba[base]!, rgba[base + 1]!, rgba[base + 2]!);
      n++;
    }
  }
  return n ? sum / n : 0;
}
