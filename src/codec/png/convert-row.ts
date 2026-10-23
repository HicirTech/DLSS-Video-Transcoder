/** Converts one reconstructed PNG scanline of any colour type and bit depth to 8-bit RGBA. */

/** Colour type 0; `transparentGrey` is the tRNS sample, raw at the file's bit depth, or null when there is none. */
interface GreyscaleFormat {
  colorType: 0;
  bitDepth: number;
  transparentGrey: number | null;
}

/** Colour type 2; `transparentRgb` is the tRNS triple, raw at the file's bit depth, or null when there is none. */
interface TruecolourFormat {
  colorType: 2;
  bitDepth: number;
  transparentRgb: readonly [red: number, green: number, blue: number] | null;
}

/** Colour type 3; `palette` holds 256 RGBA entries with the tRNS alpha applied, unused entries opaque black. */
interface IndexedFormat {
  colorType: 3;
  bitDepth: number;
  palette: Uint8Array;
}

/** Colour types 4 and 6, which carry their own alpha. */
interface AlphaFormat {
  colorType: 4 | 6;
  bitDepth: number;
}

/** Everything the row converter needs to know about the source format, per colour type. */
export type PixelFormat = GreyscaleFormat | TruecolourFormat | IndexedFormat | AlphaFormat;

/**
 * Where one row's pixels come from and go to. `targetPixelStride` is 4 for contiguous output and 4 * xStep inside
 * an Adam7 pass, whose pixels are spread across the image row.
 */
export interface RowSpan {
  source: Uint8Array;
  sourceOffset: number;
  target: Uint8Array;
  targetOffset: number;
  targetPixelStride: number;
  pixelCount: number;
}

/** Converts the `pixelCount` pixels of one reconstructed scanline to RGBA. */
export function convertRow(format: PixelFormat, span: RowSpan): void {
  switch (format.colorType) {
    case 0:
      convertGreyscaleRow(format, span);
      break;
    case 2:
      convertTruecolourRow(format, span);
      break;
    case 3:
      convertIndexedRow(format, span);
      break;
    case 4:
      convertGreyscaleAlphaRow(format, span);
      break;
    case 6:
      convertTruecolourAlphaRow(format, span);
      break;
  }
}

/** Colour type 0 at depths 1 to 16; the tRNS grey sample, compared at full depth, becomes transparent. */
function convertGreyscaleRow(format: GreyscaleFormat, span: RowSpan): void {
  const { source, target, targetPixelStride, pixelCount } = span;
  let { sourceOffset, targetOffset } = span;
  const depth = format.bitDepth;
  const transparent = format.transparentGrey;
  if (depth === 8) {
    for (let x = 0; x < pixelCount; x++) {
      const grey = source[sourceOffset++];
      target[targetOffset] = grey;
      target[targetOffset + 1] = grey;
      target[targetOffset + 2] = grey;
      target[targetOffset + 3] = grey === transparent ? 0 : 255;
      targetOffset += targetPixelStride;
    }
  } else if (depth === 16) {
    for (let x = 0; x < pixelCount; x++) {
      const high = source[sourceOffset];
      const sample = (high << 8) | source[sourceOffset + 1];
      sourceOffset += 2;
      target[targetOffset] = high;
      target[targetOffset + 1] = high;
      target[targetOffset + 2] = high;
      target[targetOffset + 3] = sample === transparent ? 0 : 255;
      targetOffset += targetPixelStride;
    }
  } else {
    // 1, 2 or 4 bits per pixel, packed most significant bit first; scale to 0..255 exactly (255, 85, 17).
    const mask = (1 << depth) - 1;
    const scale = 255 / mask;
    let bit = 0;
    for (let x = 0; x < pixelCount; x++) {
      const sample = (source[sourceOffset + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
      bit += depth;
      const grey = sample * scale;
      target[targetOffset] = grey;
      target[targetOffset + 1] = grey;
      target[targetOffset + 2] = grey;
      target[targetOffset + 3] = sample === transparent ? 0 : 255;
      targetOffset += targetPixelStride;
    }
  }
}

/** Colour type 2 at depths 8 and 16; the tRNS RGB triple, compared at full depth, becomes transparent. */
function convertTruecolourRow(format: TruecolourFormat, span: RowSpan): void {
  const { source, target, targetPixelStride, pixelCount } = span;
  let { sourceOffset, targetOffset } = span;
  // -1 matches no sample, so without a tRNS triple every pixel stays opaque.
  const [keyRed, keyGreen, keyBlue] = format.transparentRgb ?? [-1, -1, -1];
  if (format.bitDepth === 8) {
    for (let x = 0; x < pixelCount; x++) {
      const red = source[sourceOffset];
      const green = source[sourceOffset + 1];
      const blue = source[sourceOffset + 2];
      sourceOffset += 3;
      target[targetOffset] = red;
      target[targetOffset + 1] = green;
      target[targetOffset + 2] = blue;
      target[targetOffset + 3] = red === keyRed && green === keyGreen && blue === keyBlue ? 0 : 255;
      targetOffset += targetPixelStride;
    }
  } else {
    for (let x = 0; x < pixelCount; x++) {
      const red = (source[sourceOffset] << 8) | source[sourceOffset + 1];
      const green = (source[sourceOffset + 2] << 8) | source[sourceOffset + 3];
      const blue = (source[sourceOffset + 4] << 8) | source[sourceOffset + 5];
      sourceOffset += 6;
      target[targetOffset] = red >> 8;
      target[targetOffset + 1] = green >> 8;
      target[targetOffset + 2] = blue >> 8;
      target[targetOffset + 3] = red === keyRed && green === keyGreen && blue === keyBlue ? 0 : 255;
      targetOffset += targetPixelStride;
    }
  }
}

/** Colour type 3 at depths 1 to 8; the palette already carries the tRNS alpha. */
function convertIndexedRow(format: IndexedFormat, span: RowSpan): void {
  const { source, target, targetPixelStride, pixelCount } = span;
  let { sourceOffset, targetOffset } = span;
  const depth = format.bitDepth;
  const palette = format.palette;
  if (depth === 8) {
    for (let x = 0; x < pixelCount; x++) {
      const entry = source[sourceOffset++] << 2;
      target[targetOffset] = palette[entry];
      target[targetOffset + 1] = palette[entry + 1];
      target[targetOffset + 2] = palette[entry + 2];
      target[targetOffset + 3] = palette[entry + 3];
      targetOffset += targetPixelStride;
    }
  } else {
    const mask = (1 << depth) - 1;
    let bit = 0;
    for (let x = 0; x < pixelCount; x++) {
      const entry = ((source[sourceOffset + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask) << 2;
      bit += depth;
      target[targetOffset] = palette[entry];
      target[targetOffset + 1] = palette[entry + 1];
      target[targetOffset + 2] = palette[entry + 2];
      target[targetOffset + 3] = palette[entry + 3];
      targetOffset += targetPixelStride;
    }
  }
}

/** Colour type 4 at depths 8 and 16. */
function convertGreyscaleAlphaRow(format: AlphaFormat, span: RowSpan): void {
  const { source, target, targetPixelStride, pixelCount } = span;
  let { sourceOffset, targetOffset } = span;
  if (format.bitDepth === 8) {
    for (let x = 0; x < pixelCount; x++) {
      const grey = source[sourceOffset];
      const alpha = source[sourceOffset + 1];
      sourceOffset += 2;
      target[targetOffset] = grey;
      target[targetOffset + 1] = grey;
      target[targetOffset + 2] = grey;
      target[targetOffset + 3] = alpha;
      targetOffset += targetPixelStride;
    }
  } else {
    for (let x = 0; x < pixelCount; x++) {
      const grey = source[sourceOffset];
      const alpha = source[sourceOffset + 2];
      sourceOffset += 4;
      target[targetOffset] = grey;
      target[targetOffset + 1] = grey;
      target[targetOffset + 2] = grey;
      target[targetOffset + 3] = alpha;
      targetOffset += targetPixelStride;
    }
  }
}

/** Colour type 6 at depths 8 and 16. */
function convertTruecolourAlphaRow(format: AlphaFormat, span: RowSpan): void {
  const { source, target, targetPixelStride, pixelCount } = span;
  let { sourceOffset, targetOffset } = span;
  if (format.bitDepth === 8) {
    if (targetPixelStride === 4) {
      target.set(source.subarray(sourceOffset, sourceOffset + pixelCount * 4), targetOffset);
    } else {
      for (let x = 0; x < pixelCount; x++) {
        target[targetOffset] = source[sourceOffset];
        target[targetOffset + 1] = source[sourceOffset + 1];
        target[targetOffset + 2] = source[sourceOffset + 2];
        target[targetOffset + 3] = source[sourceOffset + 3];
        sourceOffset += 4;
        targetOffset += targetPixelStride;
      }
    }
  } else {
    for (let x = 0; x < pixelCount; x++) {
      target[targetOffset] = source[sourceOffset];
      target[targetOffset + 1] = source[sourceOffset + 2];
      target[targetOffset + 2] = source[sourceOffset + 4];
      target[targetOffset + 3] = source[sourceOffset + 6];
      sourceOffset += 8;
      targetOffset += targetPixelStride;
    }
  }
}
