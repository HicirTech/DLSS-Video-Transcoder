/**
 * CPU bilinear resize for tightly packed 8-bit frames, plus the even-dimension
 * rounding every target size goes through, plus the alpha split the still path
 * needs around the neural engines. Used by the still-image path to reach the
 * engine's working size; video pre-scales in ffmpeg instead.
 */

/** Nearest even value, at least 2: 4:2:0 chroma subsampling cannot encode an odd dimension. */
export function evenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Bilinear resize of an interleaved 8-bit image with `channels` samples per
 * pixel. One implementation serves RGBA and the alpha plane so the two are
 * resampled with identical taps and rounding, which is what keeps a re-attached
 * alpha aligned with the colour it came from. Returns `src` itself when the size
 * already matches — the result is not always a fresh buffer.
 */
function resizeInterleaved(src: Uint8Array, channels: number, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return src;
  if (src.byteLength !== srcWidth * srcHeight * channels) {
    throw new Error(`resize: expected ${srcWidth * srcHeight * channels} bytes, got ${src.byteLength}`);
  }
  const out = new Uint8Array(dstWidth * dstHeight * channels);
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
    x0[x] = ix * channels;
    x1[x] = Math.min(maxX, ix + 1) * channels;
    wx[x] = sx - ix;
  }

  const rowBytes = srcWidth * channels;
  let o = 0;
  for (let y = 0; y < dstHeight; y++) {
    const sy = Math.min(maxY, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const iy = Math.floor(sy);
    const wy = sy - iy;
    const row0 = iy * rowBytes;
    const row1 = Math.min(maxY, iy + 1) * rowBytes;
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
      for (let ch = 0; ch < channels; ch++) {
        out[o++] = (src[a + ch]! * w00 + src[b + ch]! * w10 + src[c + ch]! * w01 + src[d + ch]! * w11 + 0.5) | 0;
      }
    }
  }
  return out;
}

/** Bilinear resize of a tightly packed RGBA8 frame; `src` itself when the size already matches. */
export function resizeRgba(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array {
  return resizeInterleaved(src, 4, srcWidth, srcHeight, dstWidth, dstHeight);
}

/** Bilinear resize of a one-byte-per-pixel plane (an alpha plane); `src` itself when the size already matches. */
export function resizePlane(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array {
  return resizeInterleaved(src, 1, srcWidth, srcHeight, dstWidth, dstHeight);
}

/**
 * The alpha plane of an RGBA8 frame, and a copy of the frame with alpha forced
 * to 255; the inverse is attachAlpha. `rgba` is not modified. Why a still is
 * split around the neural engines is enhanceStill's (image.ts) to say.
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
