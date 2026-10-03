/** Scalar float32 <-> IEEE-754 half conversions the flow packing tests compare the buffer encoders against. */
import { bitsToHalf } from "../src/pipeline/half-float.ts";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Encode one float32 as an IEEE-754 half (Uint16) through flow.ts's bit encoder. */
export function floatToHalf(value: number): number {
  f32[0] = value;
  return bitsToHalf(u32[0]!);
}

/** Decode an IEEE-754 half (Uint16) back to a JS number. */
export function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exp = (half >>> 10) & 0x1f;
  const mant = half & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24; // subnormal: 2^-14 * mant/1024
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}
