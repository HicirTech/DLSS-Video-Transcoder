/** Converts one reconstructed PNG scanline of any colour type and bit depth to 8-bit RGBA. */
import type { PngColorType } from "./types.ts";

/** Everything the per-row converter needs to know about the source format. */
export interface PixelFormat {
  colorType: PngColorType;
  bitDepth: number;
  /** tRNS grey sample (raw value at the file's bit depth) or -1 when there is none. */
  trnsGray: number;
  /** tRNS RGB samples (raw values at the file's bit depth) or -1 when there is none. */
  trnsR: number;
  trnsG: number;
  trnsB: number;
  /** 256 RGBA entries for indexed images (unused entries are opaque black), otherwise null. */
  palette: Uint8Array | null;
}

/**
 * Converts one reconstructed scanline of `n` pixels starting at `src[s]` into RGBA at `dst[d]`, advancing the
 * destination by `dstStride` bytes per pixel (4 for contiguous output, 4 * xStep inside an Adam7 pass).
 */
export function convertRow(
  fmt: PixelFormat,
  src: Uint8Array,
  s: number,
  dst: Uint8Array,
  d: number,
  dstStride: number,
  n: number,
): void {
  switch (fmt.colorType) {
    case 0:
      convertGreyscaleRow(fmt, src, s, dst, d, dstStride, n);
      break;
    case 2:
      convertTruecolourRow(fmt, src, s, dst, d, dstStride, n);
      break;
    case 3:
      convertIndexedRow(fmt, src, s, dst, d, dstStride, n);
      break;
    case 4:
      convertGreyscaleAlphaRow(fmt, src, s, dst, d, dstStride, n);
      break;
    case 6:
      convertTruecolourAlphaRow(fmt, src, s, dst, d, dstStride, n);
      break;
  }
}

/** Colour type 0 at depths 1 to 16; a tRNS grey sample, compared at full depth, becomes transparent. */
function convertGreyscaleRow(
  fmt: PixelFormat,
  src: Uint8Array,
  s: number,
  dst: Uint8Array,
  d: number,
  dstStride: number,
  n: number,
): void {
  const depth = fmt.bitDepth;
  const trns = fmt.trnsGray;
  if (depth === 8) {
    for (let x = 0; x < n; x++) {
      const v = src[s++];
      dst[d] = v;
      dst[d + 1] = v;
      dst[d + 2] = v;
      dst[d + 3] = v === trns ? 0 : 255;
      d += dstStride;
    }
  } else if (depth === 16) {
    for (let x = 0; x < n; x++) {
      const hi = src[s];
      const v = (hi << 8) | src[s + 1];
      s += 2;
      dst[d] = hi;
      dst[d + 1] = hi;
      dst[d + 2] = hi;
      dst[d + 3] = v === trns ? 0 : 255;
      d += dstStride;
    }
  } else {
    // 1, 2 or 4 bits per pixel, packed most significant bit first; scale to 0..255 exactly (255, 85, 17).
    const mask = (1 << depth) - 1;
    const scale = 255 / mask;
    let bit = 0;
    for (let x = 0; x < n; x++) {
      const v = (src[s + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
      bit += depth;
      const g = v * scale;
      dst[d] = g;
      dst[d + 1] = g;
      dst[d + 2] = g;
      dst[d + 3] = v === trns ? 0 : 255;
      d += dstStride;
    }
  }
}

/** Colour type 2 at depths 8 and 16; a tRNS RGB triple, compared at full depth, becomes transparent. */
function convertTruecolourRow(
  fmt: PixelFormat,
  src: Uint8Array,
  s: number,
  dst: Uint8Array,
  d: number,
  dstStride: number,
  n: number,
): void {
  const depth = fmt.bitDepth;
  const tr = fmt.trnsR;
  const tg = fmt.trnsG;
  const tb = fmt.trnsB;
  if (depth === 8) {
    for (let x = 0; x < n; x++) {
      const r = src[s];
      const g = src[s + 1];
      const b = src[s + 2];
      s += 3;
      dst[d] = r;
      dst[d + 1] = g;
      dst[d + 2] = b;
      dst[d + 3] = r === tr && g === tg && b === tb ? 0 : 255;
      d += dstStride;
    }
  } else {
    for (let x = 0; x < n; x++) {
      const r = (src[s] << 8) | src[s + 1];
      const g = (src[s + 2] << 8) | src[s + 3];
      const b = (src[s + 4] << 8) | src[s + 5];
      s += 6;
      dst[d] = r >> 8;
      dst[d + 1] = g >> 8;
      dst[d + 2] = b >> 8;
      dst[d + 3] = r === tr && g === tg && b === tb ? 0 : 255;
      d += dstStride;
    }
  }
}

/** Colour type 3 at depths 1 to 8; the palette already carries the tRNS alpha. */
function convertIndexedRow(
  fmt: PixelFormat,
  src: Uint8Array,
  s: number,
  dst: Uint8Array,
  d: number,
  dstStride: number,
  n: number,
): void {
  const depth = fmt.bitDepth;
  const pal = fmt.palette as Uint8Array;
  if (depth === 8) {
    for (let x = 0; x < n; x++) {
      const p = src[s++] << 2;
      dst[d] = pal[p];
      dst[d + 1] = pal[p + 1];
      dst[d + 2] = pal[p + 2];
      dst[d + 3] = pal[p + 3];
      d += dstStride;
    }
  } else {
    const mask = (1 << depth) - 1;
    let bit = 0;
    for (let x = 0; x < n; x++) {
      const p = ((src[s + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask) << 2;
      bit += depth;
      dst[d] = pal[p];
      dst[d + 1] = pal[p + 1];
      dst[d + 2] = pal[p + 2];
      dst[d + 3] = pal[p + 3];
      d += dstStride;
    }
  }
}

/** Colour type 4 at depths 8 and 16. */
function convertGreyscaleAlphaRow(
  fmt: PixelFormat,
  src: Uint8Array,
  s: number,
  dst: Uint8Array,
  d: number,
  dstStride: number,
  n: number,
): void {
  const depth = fmt.bitDepth;
  if (depth === 8) {
    for (let x = 0; x < n; x++) {
      const v = src[s];
      const a = src[s + 1];
      s += 2;
      dst[d] = v;
      dst[d + 1] = v;
      dst[d + 2] = v;
      dst[d + 3] = a;
      d += dstStride;
    }
  } else {
    for (let x = 0; x < n; x++) {
      const v = src[s];
      const a = src[s + 2];
      s += 4;
      dst[d] = v;
      dst[d + 1] = v;
      dst[d + 2] = v;
      dst[d + 3] = a;
      d += dstStride;
    }
  }
}

/** Colour type 6 at depths 8 and 16. */
function convertTruecolourAlphaRow(
  fmt: PixelFormat,
  src: Uint8Array,
  s: number,
  dst: Uint8Array,
  d: number,
  dstStride: number,
  n: number,
): void {
  const depth = fmt.bitDepth;
  if (depth === 8) {
    if (dstStride === 4) {
      dst.set(src.subarray(s, s + n * 4), d);
    } else {
      for (let x = 0; x < n; x++) {
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
        dst[d + 3] = src[s + 3];
        s += 4;
        d += dstStride;
      }
    }
  } else {
    for (let x = 0; x < n; x++) {
      dst[d] = src[s];
      dst[d + 1] = src[s + 2];
      dst[d + 2] = src[s + 4];
      dst[d + 3] = src[s + 6];
      s += 8;
      d += dstStride;
    }
  }
}
