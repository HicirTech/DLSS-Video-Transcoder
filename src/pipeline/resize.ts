/**
 * CPU bilinear resize for tightly packed RGBA8 frames, plus the even-dimension
 * rounding every target size goes through. Used by the still-image path to
 * reach the engine's working size; video pre-scales in ffmpeg instead.
 */

/** Nearest even value, at least 2: 4:2:0 chroma subsampling cannot encode an odd dimension. */
export function evenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Returns `src` itself when the size already matches — the result is not always a fresh buffer. */
export function resizeRgba(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return src;
  if (src.byteLength !== srcWidth * srcHeight * 4) {
    throw new Error(`resizeRgba: expected ${srcWidth * srcHeight * 4} bytes, got ${src.byteLength}`);
  }
  const out = new Uint8Array(dstWidth * dstHeight * 4);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  const maxX = srcWidth - 1;
  const maxY = srcHeight - 1;

  // Column taps and weights are identical for every row, so they are hoisted
  // out of the row loop; the 0.5 offsets sample pixel centres, not corners.
  const x0 = new Int32Array(dstWidth);
  const x1 = new Int32Array(dstWidth);
  const wx = new Float32Array(dstWidth);
  for (let x = 0; x < dstWidth; x++) {
    const sx = Math.min(maxX, Math.max(0, (x + 0.5) * scaleX - 0.5));
    const ix = Math.floor(sx);
    x0[x] = ix * 4;
    x1[x] = Math.min(maxX, ix + 1) * 4;
    wx[x] = sx - ix;
  }

  let o = 0;
  for (let y = 0; y < dstHeight; y++) {
    const sy = Math.min(maxY, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const iy = Math.floor(sy);
    const wy = sy - iy;
    const row0 = iy * srcWidth * 4;
    const row1 = Math.min(maxY, iy + 1) * srcWidth * 4;
    for (let x = 0; x < dstWidth; x++) {
      const a = row0 + x0[x]!;
      const b = row0 + x1[x]!;
      const c = row1 + x0[x]!;
      const d = row1 + x1[x]!;
      const fx = wx[x]!;
      const w00 = (1 - fx) * (1 - wy);
      const w10 = fx * (1 - wy);
      const w01 = (1 - fx) * wy;
      const w11 = fx * wy;
      for (let ch = 0; ch < 4; ch++) {
        out[o++] = (src[a + ch]! * w00 + src[b + ch]! * w10 + src[c + ch]! * w01 + src[d + ch]! * w11 + 0.5) | 0;
      }
    }
  }
  return out;
}
