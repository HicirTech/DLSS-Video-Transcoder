/** PNG encoder: always colour type 6 at depth 8; the zlib layer is node:zlib, not Bun's (see encodePng). */
import { deflateSync as nodeDeflate } from "node:zlib";
import { PNG_SIGNATURE, TYPE_IDAT, TYPE_IEND, TYPE_IHDR, writeChunkInto, writeU32 } from "./chunks.ts";
import { PngError, type PngEncodeOptions, type RgbaImage } from "./types.ts";

/**
 * Encodes an 8-bit RGBA image as a PNG: colour type 6, bit depth 8, no interlace, filter type 0 on
 * every scanline, the whole zlib stream in one IDAT chunk.
 *
 * @throws {PngError} when the dimensions, buffer length or compression level are invalid.
 */
export function encodePng(img: RgbaImage, options: PngEncodeOptions = {}): Uint8Array {
  const { width, height, rgba } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngError(`invalid image dimensions ${width}x${height}`);
  }
  if (width > 0x7fffffff || height > 0x7fffffff) {
    throw new PngError(`image dimensions ${width}x${height} exceed the 2^31-1 limit`);
  }
  const rowBytes = width * 4;
  if (rgba.length !== rowBytes * height) {
    throw new PngError(`rgba has ${rgba.length} bytes, expected ${rowBytes * height} for ${width}x${height} RGBA`);
  }
  const level = options.level ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new PngError(`compression level must be an integer from 0 to 9, got ${String(level)}`);
  }

  // The extra byte per row is the filter-type byte, left at 0 (None).
  const stride = rowBytes + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0, src = 0, dst = 1; y < height; y++, src += rowBytes, dst += stride) {
    raw.set(rgba.subarray(src, src + rowBytes), dst);
  }
  // node:zlib, not Bun.deflateSync: Bun 1.4.2's deflate emits a stream that strict decoders
  // (ffmpeg/libpng) reject, so our own PNGs were unreadable outside this codec.
  const compressed = new Uint8Array(nodeDeflate(raw, { level }));

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const out = new Uint8Array(8 + (12 + 13) + (12 + compressed.length) + 12);
  out.set(PNG_SIGNATURE, 0);
  let pos = 8;
  pos = writeChunkInto(out, pos, TYPE_IHDR, ihdr);
  pos = writeChunkInto(out, pos, TYPE_IDAT, compressed);
  writeChunkInto(out, pos, TYPE_IEND, null);
  return out;
}
