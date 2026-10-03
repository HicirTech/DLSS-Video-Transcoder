/** Upsamples the grid-resolution flow field to render resolution: bilinear resize, or fused resize + scale + half-pack. */
import { bitsToHalf } from "./half-float.ts";

/** Float16Array when the runtime provides it — Bun 1.4 does — otherwise null. */
interface HalfArray {
  set(values: ArrayLike<number>, offset?: number): void;
}
const HALF_ARRAY = (globalThis as unknown as { Float16Array?: new (buffer: ArrayBufferLike) => HalfArray }).Float16Array ?? null;

/**
 * Fused upsample + scale (grid pixels -> render pixels, x by outW/inW, y by
 * outH/inH) + half packing, one row at a time. Bit-identical to
 * `encodeMotionR16G16` of the scaled `resizeFlowBilinear` output — the same
 * float32 rounding happens at the same two points — but without its two
 * full-resolution float32 passes and intermediate. Every grid sample must be
 * finite; the caller checks that with `allFinite`.
 */
export function packFlowResizedR16G16(flow: Float32Array, inW: number, inH: number, outW: number, outH: number): Uint16Array {
  const out = new Uint16Array(outW * outH * 2);
  const kx = outW / inW;
  const ky = outH / inH;
  const sx = inW > 1 && outW > 1 ? (inW - 1) / (outW - 1) : 0;
  const sy = inH > 1 && outH > 1 ? (inH - 1) / (outH - 1) : 0;
  // Column positions and weights repeat for every row. The weights stay float64,
  // exactly as resizeFlowBilinear computes them, to keep the results identical.
  const x0s = new Int32Array(outW);
  const x1s = new Int32Array(outW);
  const wxs = new Float64Array(outW);
  for (let ox = 0; ox < outW; ox++) {
    const fx = ox * sx;
    const x0 = Math.floor(fx);
    x0s[ox] = x0;
    x1s[ox] = Math.min(x0 + 1, inW - 1);
    wxs[ox] = fx - x0;
  }
  const row = new Float32Array(outW * 2);
  const rowBits = new Uint32Array(row.buffer);
  // Float16Array (ES2025) rounds to nearest-even, so it matches bitsToHalf on
  // finite values while converting ~5x faster; the scalar loop is the fallback
  // for runtimes without it.
  const outHalf = HALF_ARRAY ? new HALF_ARRAY(out.buffer) : null;
  // Upsampling means sy < 1, so consecutive output rows keep reusing the same
  // two horizontally-interpolated input rows: a two-slot cache drops the
  // horizontal pass from 2*outH runs to about inH. Still float64 until the
  // fround, so the result is unchanged.
  const cachedRow = [new Float64Array(outW * 2), new Float64Array(outW * 2)];
  const cachedIndex = [-1, -1];
  let nextSlot = 0;
  const horizontal = (yRow: number): Float64Array => {
    if (cachedIndex[0] === yRow) return cachedRow[0]!;
    if (cachedIndex[1] === yRow) return cachedRow[1]!;
    const slot = nextSlot;
    nextSlot ^= 1;
    const dst = cachedRow[slot]!;
    cachedIndex[slot] = yRow;
    const base = yRow * inW * 2;
    for (let ox = 0; ox < outW; ox++) {
      const wx = wxs[ox]!;
      const a = base + x0s[ox]! * 2;
      const b = base + x1s[ox]! * 2;
      const o = ox * 2;
      dst[o] = flow[a]! * (1 - wx) + flow[b]! * wx;
      dst[o + 1] = flow[a + 1]! * (1 - wx) + flow[b + 1]! * wx;
    }
    return dst;
  };
  for (let oy = 0; oy < outH; oy++) {
    const fy = oy * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, inH - 1);
    const wy = fy - y0;
    const top = horizontal(y0);
    const bottom = y1 === y0 ? top : horizontal(y1);
    const wt = 1 - wy;
    for (let i = 0; i < outW * 2; i += 2) {
      // Math.fround stands in for the float32 store the reference path makes
      // before the scale multiply; without it the two paths would diverge.
      row[i] = Math.fround(top[i]! * wt + bottom[i]! * wy) * kx;
      row[i + 1] = Math.fround(top[i + 1]! * wt + bottom[i + 1]! * wy) * ky;
    }
    const base = oy * outW * 2;
    if (outHalf) outHalf.set(row, base);
    else for (let i = 0; i < rowBits.length; i++) out[base + i] = bitsToHalf(rowBits[i]!);
  }
  return out;
}

/** True when every value of the buffer is finite. */
export function allFinite(values: Float32Array): boolean {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i]!)) return false;
  return true;
}

/**
 * Bilinearly resize an interleaved (dx, dy) flow field from (inW, inH) to
 * (outW, outH). Magnitudes are NOT rescaled here: the caller multiplies the
 * channels by outW/inW and outH/inH afterward, as guides.py does.
 */
export function resizeFlowBilinear(flow: Float32Array, inW: number, inH: number, outW: number, outH: number): Float32Array {
  const out = new Float32Array(outW * outH * 2);
  if (inW === outW && inH === outH) {
    out.set(flow);
    return out;
  }
  const sx = inW > 1 && outW > 1 ? (inW - 1) / (outW - 1) : 0;
  const sy = inH > 1 && outH > 1 ? (inH - 1) / (outH - 1) : 0;
  for (let oy = 0; oy < outH; oy++) {
    const fy = oy * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, inH - 1);
    const wy = fy - y0;
    for (let ox = 0; ox < outW; ox++) {
      const fx = ox * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, inW - 1);
      const wx = fx - x0;
      const i00 = (y0 * inW + x0) * 2;
      const i10 = (y0 * inW + x1) * 2;
      const i01 = (y1 * inW + x0) * 2;
      const i11 = (y1 * inW + x1) * 2;
      const o = (oy * outW + ox) * 2;
      for (let c = 0; c < 2; c++) {
        const top = flow[i00 + c]! * (1 - wx) + flow[i10 + c]! * wx;
        const bot = flow[i01 + c]! * (1 - wx) + flow[i11 + c]! * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return out;
}
