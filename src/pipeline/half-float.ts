/** IEEE-754 half-precision (float16) encoding of float32 bits and of whole motion buffers in the R16G16_FLOAT layout. */

/**
 * Encode the raw IEEE-754 bits of a float32 as an IEEE-754 half (Uint16):
 * normals, subnormals, signed zero, overflow -> Inf and NaN, rounding the
 * mantissa to nearest-even as R16G16_FLOAT does. Taking the bits lets a whole
 * buffer convert through a Uint32Array view with integer ops only instead of
 * one scalar store/load per element.
 */
export function bitsToHalf(x: number): number {
  const sign = (x >>> 16) & 0x8000;
  const rawExp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;

  if (rawExp === 0xff) {
    // Inf (mant 0) or NaN (mant != 0, keep it quiet/non-zero).
    return sign | 0x7c00 | (mant ? 0x0200 : 0);
  }

  let exp = rawExp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00; // overflow -> Inf
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow -> signed zero
    // Subnormal: shift the implicit-1 mantissa down into 10 bits.
    const m = mant | 0x800000;
    const shift = 14 - exp;
    let half = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (half & 1))) half++;
    return sign | half;
  }
  // Normal: keep top 10 mantissa bits, round the dropped 13 to nearest-even.
  let half = (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++; // carry into exp is fine
  return sign | half;
}

/**
 * Pack an interleaved (x, y) Float32 motion buffer into halves, keeping the
 * interleaving (R=x, G=y) so it uploads as DXGI_FORMAT_R16G16_FLOAT unchanged.
 */
export function encodeMotionR16G16(motion: Float32Array): Uint16Array {
  const out = new Uint16Array(motion.length);
  // A Float32Array's byteOffset is always 4-aligned, so the bit view is valid.
  const bits = new Uint32Array(motion.buffer, motion.byteOffset, motion.length);
  for (let i = 0; i < motion.length; i++) out[i] = bitsToHalf(bits[i]!);
  return out;
}
