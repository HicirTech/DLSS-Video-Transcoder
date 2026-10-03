/**
 * The raster type, colour-type codes, encoder options and error class shared by every module of the
 * dependency-free PNG codec.
 */

/** An 8-bit RGBA raster: `rgba` holds exactly `width * height * 4` bytes, row-major, top row first, no padding. */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** PNG colour types: 0 greyscale, 2 truecolour, 3 indexed-colour, 4 greyscale + alpha, 6 truecolour + alpha. */
export type PngColorType = 0 | 2 | 3 | 4 | 6;

/** Options for {@link encodePng}. */
export interface PngEncodeOptions {
  /** zlib compression level, an integer from 0 (store only) to 9 (smallest output). Default 6. */
  level?: number;
}

/** Thrown for corrupt, truncated or unsupported PNG input and for invalid encoder arguments. */
export class PngError extends Error {
  constructor(message: string) {
    super(`PNG: ${message}`);
    this.name = "PngError";
  }
}
