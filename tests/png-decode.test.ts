/** Decoding of hand-built files for every colour type and bit depth, and of all five scanline filters. */
import { describe, expect, test } from "bun:test";
import { deflateSync as nodeDeflate } from "node:zlib";
import { decodePng } from "../src/codec/png/decode.ts";
import {
  IEND,
  type ImageSpec,
  buildImageData,
  chunk,
  concat,
  expectSameImage,
  expectedRgba,
  firstDifference,
  idat,
  ihdr,
  png,
  randomImage,
  u16,
} from "./png-reference.ts";

describe("hand-constructed images", () => {
  test("2x2 8-bit RGB", () => {
    const rows = concat([
      [0, 255, 0, 0, 0, 255, 0],
      [0, 0, 0, 255, 10, 20, 30],
    ]);
    const decoded = decodePng(png(ihdr(2, 2, 8, 2), idat(rows), IEND));
    expectSameImage(decoded, 2, 2, Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]));
  });

  test("4x1 1-bit greyscale", () => {
    const decoded = decodePng(png(ihdr(4, 1, 1, 0), idat(concat([[0, 0b1010_0000]])), IEND));
    expectSameImage(decoded, 4, 1, Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]));
  });

  test("2x2 8-bit palette with tRNS", () => {
    const plte = chunk("PLTE", [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const trns = chunk("tRNS", [0, 128, 255]); // 4th entry has no tRNS byte and stays opaque
    const rows = concat([
      [0, 0, 1],
      [0, 2, 3],
    ]);
    const decoded = decodePng(png(ihdr(2, 2, 8, 3), plte, trns, idat(rows), IEND));
    expectSameImage(decoded, 2, 2, Uint8Array.from([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 255]));
  });

  test("2x2 2-bit palette with tRNS", () => {
    const plte = chunk("PLTE", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const trns = chunk("tRNS", [200]);
    const rows = concat([
      [0, 0b00_01_0000], // indices 0, 1
      [0, 0b10_11_0000], // indices 2, 3
    ]);
    const decoded = decodePng(png(ihdr(2, 2, 2, 3), plte, trns, idat(rows), IEND));
    expectSameImage(decoded, 2, 2, Uint8Array.from([1, 2, 3, 200, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]));
  });

  test("2x1 16-bit RGBA keeps the high byte of every sample", () => {
    const row = concat([[0], u16(0x1234), u16(0x5678), u16(0x9abc), u16(0xdef0), u16(0x00ff), u16(0xff00), u16(0x0102), u16(0x8081)]);
    const decoded = decodePng(png(ihdr(2, 1, 16, 6), idat(row), IEND));
    expectSameImage(decoded, 2, 1, Uint8Array.from([0x12, 0x56, 0x9a, 0xde, 0x00, 0xff, 0x01, 0x80]));
  });

  test("16-bit greyscale tRNS compares all 16 bits", () => {
    const trns = chunk("tRNS", u16(0x1234));
    const row = concat([[0], u16(0x1234), u16(0x1200), u16(0xffff)]);
    const decoded = decodePng(png(ihdr(3, 1, 16, 0), trns, idat(row), IEND));
    expectSameImage(decoded, 3, 1, Uint8Array.from([0x12, 0x12, 0x12, 0, 0x12, 0x12, 0x12, 255, 255, 255, 255, 255]));
  });

  test("8-bit greyscale with tRNS", () => {
    const trns = chunk("tRNS", u16(7));
    const decoded = decodePng(png(ihdr(3, 1, 8, 0), trns, idat(concat([[0, 7, 8, 0]])), IEND));
    expectSameImage(decoded, 3, 1, Uint8Array.from([7, 7, 7, 0, 8, 8, 8, 255, 0, 0, 0, 255]));
  });

  test("4-bit and 2-bit greyscale scale to the full 0..255 range", () => {
    const four = decodePng(png(ihdr(3, 1, 4, 0), idat(concat([[0, 0x0f, 0x80]])), IEND));
    expectSameImage(four, 3, 1, Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 136, 136, 136, 255]));
    const two = decodePng(png(ihdr(4, 1, 2, 0), idat(concat([[0, 0b00_01_10_11]])), IEND));
    expectSameImage(two, 4, 1, Uint8Array.from([0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255]));
  });

  test("1-bit greyscale with tRNS and a partial last byte", () => {
    const trns = chunk("tRNS", u16(1));
    const rows = concat([
      [0, 0b1100_1000], // 5 pixels: 1 1 0 0 1 (remaining bits are padding)
      [0, 0b0000_0000],
    ]);
    const decoded = decodePng(png(ihdr(5, 2, 1, 0), trns, idat(rows), IEND));
    const white = [255, 255, 255, 0]; // sample 1 is transparent via tRNS
    const black = [0, 0, 0, 255];
    expectSameImage(decoded, 5, 2, Uint8Array.from([...white, ...white, ...black, ...black, ...white, ...black, ...black, ...black, ...black, ...black]));
  });

  test("8-bit RGB with tRNS", () => {
    const trns = chunk("tRNS", [...u16(1), ...u16(2), ...u16(3)]);
    const decoded = decodePng(png(ihdr(2, 1, 8, 2), trns, idat(concat([[0, 1, 2, 3, 1, 2, 4]])), IEND));
    expectSameImage(decoded, 2, 1, Uint8Array.from([1, 2, 3, 0, 1, 2, 4, 255]));
  });

  test("16-bit RGB with tRNS", () => {
    const trns = chunk("tRNS", [...u16(0x1111), ...u16(0x2222), ...u16(0x3333)]);
    const row = concat([[0], u16(0x1111), u16(0x2222), u16(0x3333), u16(0x1111), u16(0x2222), u16(0x3334)]);
    const decoded = decodePng(png(ihdr(2, 1, 16, 2), trns, idat(row), IEND));
    expectSameImage(decoded, 2, 1, Uint8Array.from([0x11, 0x22, 0x33, 0, 0x11, 0x22, 0x33, 255]));
  });

  test("greyscale + alpha at 8 and 16 bits", () => {
    const eight = decodePng(png(ihdr(2, 1, 8, 4), idat(concat([[0, 10, 20, 30, 40]])), IEND));
    expectSameImage(eight, 2, 1, Uint8Array.from([10, 10, 10, 20, 30, 30, 30, 40]));
    const sixteen = decodePng(png(ihdr(2, 1, 16, 4), idat(concat([[0], u16(0xabcd), u16(0x1234), u16(0x0080), u16(0xff01)])), IEND));
    expectSameImage(sixteen, 2, 1, Uint8Array.from([0xab, 0xab, 0xab, 0x12, 0x00, 0x00, 0x00, 0xff]));
  });

  test("multiple IDAT chunks are concatenated before inflating", () => {
    const image = randomImage(23, 11, 77);
    const rows = buildImageData({ width: 23, height: 11, bitDepth: 8, channels: 4, samples: (x, y) => Array.from(image.rgba.subarray((y * 23 + x) * 4, (y * 23 + x) * 4 + 4)) });
    const stream = new Uint8Array(nodeDeflate(rows));
    const parts = [stream.subarray(0, 1), stream.subarray(1, 1), stream.subarray(1, 30), stream.subarray(30)];
    const file = png(ihdr(23, 11, 8, 6), ...parts.map((p) => chunk("IDAT", p)), IEND);
    expectSameImage(decodePng(file), 23, 11, image.rgba);
  });

  test("ancillary chunks are ignored, including unknown private ones", () => {
    const rows = concat([[0, 1, 2, 3, 4]]);
    const gama = chunk("gAMA", [0, 0, 0xb1, 0x8f]);
    const text = chunk("tEXt", Array.from(new TextEncoder().encode("Comment\0hello")));
    const priv = chunk("prVt", [9, 9, 9]);
    const decoded = decodePng(png(ihdr(1, 1, 8, 6), gama, text, idat(rows), priv, IEND));
    expectSameImage(decoded, 1, 1, Uint8Array.from([1, 2, 3, 4]));
  });
});

describe("filters", () => {
  const rgbaSpec = (filter: number | ((row: number) => number)): ImageSpec => ({
    width: 5,
    height: 4,
    bitDepth: 8,
    channels: 4,
    filter,
    samples: (x, y) => [(x * 53 + y * 11) & 0xff, (x * 97 + y * 31 + 7) & 0xff, (x * x + y * y * 3) & 0xff, (200 - x * 20 - y * 9) & 0xff],
  });
  const rgbaExpected = expectedRgba(5, 4, rgbaSpec(0).samples);

  const names = ["None", "Sub", "Up", "Average", "Paeth"];
  for (const type of [1, 2, 3, 4]) {
    test(`filter type ${type} (${names[type]}) on every scanline of an RGBA image`, () => {
      const data = buildImageData(rgbaSpec(type));
      // Sanity check the construction itself: every scanline carries the requested filter byte.
      for (let row = 0; row < 4; row++) expect(data[row * 21]).toBe(type);
      const decoded = decodePng(png(ihdr(5, 4, 8, 6), idat(data), IEND));
      expectSameImage(decoded, 5, 4, rgbaExpected);
    });
  }

  test("filters really change the stored bytes", () => {
    const none = buildImageData(rgbaSpec(0));
    for (const type of [1, 2, 3, 4]) expect(firstDifference(buildImageData(rgbaSpec(type)), none)).not.toBe(-1);
  });

  test("a different filter on every row (RGBA)", () => {
    const decoded = decodePng(png(ihdr(5, 4, 8, 6), idat(buildImageData(rgbaSpec((row) => (row + 1) % 5))), IEND));
    expectSameImage(decoded, 5, 4, rgbaExpected);
  });

  test("mixed filters on 8-bit RGB (3 bytes per pixel)", () => {
    const spec: ImageSpec = { width: 7, height: 5, bitDepth: 8, channels: 3, filter: (row) => 4 - (row % 5), samples: (x, y) => [(x * 40 + y) & 0xff, (y * 60 + x * 3) & 0xff, (x * y * 13 + 100) & 0xff] };
    const decoded = decodePng(png(ihdr(7, 5, 8, 2), idat(buildImageData(spec)), IEND));
    expectSameImage(decoded, 7, 5, expectedRgba(7, 5, (x, y) => [...spec.samples(x, y), 255]));
  });

  test("mixed filters on 16-bit greyscale (2 bytes per pixel)", () => {
    const spec: ImageSpec = { width: 6, height: 6, bitDepth: 16, channels: 1, filter: (row) => [3, 4, 1, 2, 4, 3][row], samples: (x, y) => [(x * 9137 + y * 21001) & 0xffff] };
    const decoded = decodePng(png(ihdr(6, 6, 16, 0), idat(buildImageData(spec)), IEND));
    expectSameImage(decoded, 6, 6, expectedRgba(6, 6, (x, y) => {
      const hi = spec.samples(x, y)[0] >> 8;
      return [hi, hi, hi, 255];
    }));
  });

  test("mixed filters on 16-bit RGBA (8 bytes per pixel)", () => {
    const spec: ImageSpec = { width: 3, height: 4, bitDepth: 16, channels: 4, filter: (row) => [4, 3, 2, 1][row], samples: (x, y) => [x * 20000 + y, y * 15000 + x, (x + y) * 4097, 65535 - x * 300 - y * 700] };
    const decoded = decodePng(png(ihdr(3, 4, 16, 6), idat(buildImageData(spec)), IEND));
    expectSameImage(decoded, 3, 4, expectedRgba(3, 4, (x, y) => spec.samples(x, y).map((v) => v >> 8)));
  });

  test("mixed filters on 1-bit greyscale (filters operate on the packed bytes)", () => {
    const spec: ImageSpec = { width: 11, height: 5, bitDepth: 1, channels: 1, filter: (row) => [1, 2, 3, 4, 1][row], samples: (x, y) => [(x * 7 + y * 3) % 5 < 2 ? 1 : 0] };
    const decoded = decodePng(png(ihdr(11, 5, 1, 0), idat(buildImageData(spec)), IEND));
    expectSameImage(decoded, 11, 5, expectedRgba(11, 5, (x, y) => {
      const v = spec.samples(x, y)[0] * 255;
      return [v, v, v, 255];
    }));
  });
});
