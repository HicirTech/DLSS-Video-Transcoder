import { describe, expect, test } from "bun:test";
import { smallGray } from "../src/pipeline/flow-grid.ts";

/** The general box-average path of smallGray, kept here as the reference the integer fast path must match exactly. */
function referenceSmallGray(rgba: Uint8Array, width: number, height: number, flowW: number, flowH: number): Float32Array {
  const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;
  const out = new Float32Array(flowW * flowH);
  for (let oy = 0; oy < flowH; oy++) {
    const y0 = Math.floor((oy * height) / flowH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / flowH));
    for (let ox = 0; ox < flowW; ox++) {
      const x0 = Math.floor((ox * width) / flowW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / flowW));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        let base = (y * width + x0) * 4;
        for (let x = x0; x < x1 && x < width; x++, base += 4) {
          sum += luma(rgba[base]!, rgba[base + 1]!, rgba[base + 2]!);
          n++;
        }
      }
      out[oy * flowW + ox] = n ? sum / n : 0;
    }
  }
  return out;
}

function noise(width: number, height: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    rgba[i] = i % 4 === 3 ? 255 : s >>> 24;
  }
  return rgba;
}

describe("smallGray", () => {
  test("integer downscale ratios are bit-identical to the general box average", () => {
    for (const [w, h, fw, fh] of [
      [1280, 720, 640, 360], // the production 720p case: 2x2 blocks
      [1920, 1080, 640, 360], // 3x3 blocks: the 1080p case
      [64, 36, 32, 18],
      [96, 48, 32, 16], // 3x3 blocks
      [40, 30, 8, 6], // 5x5 blocks
      [16, 9, 16, 9], // 1x1: a plain luma pass
    ] as const) {
      const rgba = noise(w, h, w * 31 + h);
      expect(smallGray(rgba, { width: w, height: h }, { flowW: fw, flowH: fh })).toEqual(referenceSmallGray(rgba, w, h, fw, fh));
    }
  });

  test("non-integer ratios still take the general path and match it", () => {
    for (const [width, height, flowW, flowH] of [
      [64, 37, 32, 18], // width divides, height does not: must not take the integer path
      [65, 36, 32, 18], // height divides, width does not
      [1920, 800, 640, 266], // a production shape: 3 across, not 3 down
      [33, 19, 10, 7],
      [50, 33, 16, 9],
      [7, 5, 4, 3], // upscale-ish: blocks clamp to a single pixel
    ] as const) {
      const rgba = noise(width, height, width * 17 + height);
      expect(smallGray(rgba, { width, height }, { flowW, flowH })).toEqual(referenceSmallGray(rgba, width, height, flowW, flowH));
    }
  });

  test("a flat frame averages to its own luma", () => {
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 8 * 8; i++) {
      rgba[i * 4] = 10;
      rgba[i * 4 + 1] = 20;
      rgba[i * 4 + 2] = 30;
      rgba[i * 4 + 3] = 255;
    }
    const expected = 0.299 * 10 + 0.587 * 20 + 0.114 * 30;
    for (const value of smallGray(rgba, { width: 8, height: 8 }, { flowW: 4, flowH: 4 })) expect(value).toBeCloseTo(expected, 5);
  });
});
