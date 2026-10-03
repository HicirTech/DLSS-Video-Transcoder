/** Adam7 interlacing: pass layout, per-pass filters and partial passes, built independently of the decoder. */
import { describe, expect, test } from "bun:test";
import { decodePng } from "../src/codec/png/decode.ts";
import {
  IEND,
  buildImageData,
  chunk,
  expectSameImage,
  expectedRgba,
  idat,
  ihdr,
  png,
  randomImage,
  u16,
} from "./png-reference.ts";

describe("Adam7 interlacing", () => {
  const rgba8x8 = (x: number, y: number): number[] => [x * 32, y * 32, (x * 17 + y * 5) & 0xff, 255 - (x + y) * 8];

  test("8x8 RGBA with an independently computed pass layout", () => {
    const data = buildImageData({ width: 8, height: 8, bitDepth: 8, channels: 4, interlaced: true, samples: rgba8x8 });
    // Pass sizes for 8x8: 1x1, 1x1, 2x1, 2x2, 4x2, 4x4, 8x4 pixels -> rows * (1 + 4 * width) bytes each.
    expect(data.length).toBe(1 * 5 + 1 * 5 + 1 * 9 + 2 * 9 + 2 * 17 + 4 * 17 + 4 * 33);
    // The first pass holds pixel (0,0) and the second pass pixel (4,0).
    expect(Array.from(data.subarray(1, 5))).toEqual(rgba8x8(0, 0));
    expect(Array.from(data.subarray(6, 10))).toEqual(rgba8x8(4, 0));
    const decoded = decodePng(png(ihdr(8, 8, 8, 6, 1), idat(data), IEND));
    expectSameImage(decoded, 8, 8, expectedRgba(8, 8, rgba8x8));
  });

  test("8x8 RGBA with a Sub filter inside every pass", () => {
    const data = buildImageData({ width: 8, height: 8, bitDepth: 8, channels: 4, interlaced: true, filter: 1, samples: rgba8x8 });
    const decoded = decodePng(png(ihdr(8, 8, 8, 6, 1), idat(data), IEND));
    expectSameImage(decoded, 8, 8, expectedRgba(8, 8, rgba8x8));
  });

  test("8x8 RGBA with Paeth and Up filters inside every pass", () => {
    const data = buildImageData({ width: 8, height: 8, bitDepth: 8, channels: 4, interlaced: true, filter: (row) => (row % 2 ? 2 : 4), samples: rgba8x8 });
    const decoded = decodePng(png(ihdr(8, 8, 8, 6, 1), idat(data), IEND));
    expectSameImage(decoded, 8, 8, expectedRgba(8, 8, rgba8x8));
  });

  test("13x7 8-bit greyscale: partial passes", () => {
    const grey = (x: number, y: number): number[] => [(x * 19 + y * 7) & 0xff];
    const data = buildImageData({ width: 13, height: 7, bitDepth: 8, channels: 1, interlaced: true, filter: (row) => row % 5, samples: grey });
    const decoded = decodePng(png(ihdr(13, 7, 8, 0, 1), idat(data), IEND));
    expectSameImage(decoded, 13, 7, expectedRgba(13, 7, (x, y) => [grey(x, y)[0], grey(x, y)[0], grey(x, y)[0], 255]));
  });

  test("1x1 RGBA: only the first pass has any data", () => {
    const data = buildImageData({ width: 1, height: 1, bitDepth: 8, channels: 4, interlaced: true, samples: () => [9, 8, 7, 6] });
    expect(data.length).toBe(5);
    const decoded = decodePng(png(ihdr(1, 1, 8, 6, 1), idat(data), IEND));
    expectSameImage(decoded, 1, 1, Uint8Array.from([9, 8, 7, 6]));
  });

  test("3x2 RGBA: passes with columns but no rows contribute nothing", () => {
    const pixel = (x: number, y: number): number[] => [x * 50, y * 100, x + y, 255];
    const data = buildImageData({ width: 3, height: 2, bitDepth: 8, channels: 4, interlaced: true, samples: pixel });
    // Only passes 1 (pixel 0,0), 4 (pixel 2,0), 6 (pixel 1,0) and 7 (row 1: 3 pixels) have data.
    expect(data.length).toBe(5 + 5 + 5 + 13);
    const decoded = decodePng(png(ihdr(3, 2, 8, 6, 1), idat(data), IEND));
    expectSameImage(decoded, 3, 2, expectedRgba(3, 2, pixel));
  });

  test("5x5 2-bit palette: sub-byte rows are packed per pass", () => {
    const plte = chunk("PLTE", [10, 0, 0, 0, 20, 0, 0, 0, 30, 40, 40, 40]);
    const trns = chunk("tRNS", [255, 0]);
    const index = (x: number, y: number): number[] => [(x + y) & 3];
    const data = buildImageData({ width: 5, height: 5, bitDepth: 2, channels: 1, interlaced: true, samples: index });
    const decoded = decodePng(png(ihdr(5, 5, 2, 3, 1), plte, trns, idat(data), IEND));
    const palette = [
      [10, 0, 0, 255],
      [0, 20, 0, 0],
      [0, 0, 30, 255],
      [40, 40, 40, 255],
    ];
    expectSameImage(decoded, 5, 5, expectedRgba(5, 5, (x, y) => palette[index(x, y)[0]]));
  });

  test("17x9 16-bit RGB interlaced with tRNS", () => {
    const trns = chunk("tRNS", [...u16(0x0100), ...u16(0x0200), ...u16(0x0300)]);
    const rgb = (x: number, y: number): number[] => (x === 3 && y === 5 ? [0x0100, 0x0200, 0x0300] : [x * 3000, y * 7000, (x * y) & 0xffff]);
    const data = buildImageData({ width: 17, height: 9, bitDepth: 16, channels: 3, interlaced: true, filter: (row) => (row * 3) % 5, samples: rgb });
    const decoded = decodePng(png(ihdr(17, 9, 16, 2, 1), trns, idat(data), IEND));
    expectSameImage(decoded, 17, 9, expectedRgba(17, 9, (x, y) => {
      const [r, g, b] = rgb(x, y);
      return [r >> 8, g >> 8, b >> 8, x === 3 && y === 5 ? 0 : 255];
    }));
  });

  test("interlaced and non-interlaced encodings of the same image decode identically", () => {
    const image = randomImage(37, 23, 99);
    const samples = (x: number, y: number): number[] => Array.from(image.rgba.subarray((y * 37 + x) * 4, (y * 37 + x) * 4 + 4));
    const plain = png(ihdr(37, 23, 8, 6, 0), idat(buildImageData({ width: 37, height: 23, bitDepth: 8, channels: 4, samples })), IEND);
    const laced = png(ihdr(37, 23, 8, 6, 1), idat(buildImageData({ width: 37, height: 23, bitDepth: 8, channels: 4, interlaced: true, filter: (row) => row % 5, samples })), IEND);
    expectSameImage(decodePng(plain), 37, 23, image.rgba);
    expectSameImage(decodePng(laced), 37, 23, image.rgba);
  });
});
