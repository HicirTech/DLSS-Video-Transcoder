/** Failure modes of the PNG decoder and encoder: every malformed input must raise a PngError that names the problem. */
import { describe, expect, test } from "bun:test";
import { decodePng } from "../src/codec/png/decode.ts";
import { encodePng } from "../src/codec/png/encode.ts";
import { PngError } from "../src/codec/png/types.ts";
import { IEND, chunk, concat, idat, ihdr, png, randomImage } from "./png-reference.ts";

describe("errors", () => {
  const valid = encodePng(randomImage(4, 4, 1));

  test("truncated file", () => {
    expect(() => decodePng(valid.subarray(0, valid.length >> 1))).toThrow(/truncated/);
    expect(() => decodePng(valid.subarray(0, 4))).toThrow(PngError);
    expect(() => decodePng(valid.subarray(0, 20))).toThrow(/truncated/);
    expect(() => decodePng(valid.subarray(0, valid.length - 1))).toThrow(/truncated/);
  });

  test("missing IEND", () => {
    expect(() => decodePng(valid.subarray(0, valid.length - 12))).toThrow(/IEND/);
  });

  test("bad CRC", () => {
    const badIhdrCrc = Uint8Array.from(valid);
    badIhdrCrc[8 + 8 + 13] ^= 0x01; // first CRC byte of IHDR
    expect(() => decodePng(badIhdrCrc)).toThrow(/CRC mismatch in chunk "IHDR"/);
    const badIdatData = Uint8Array.from(valid);
    badIdatData[8 + 25 + 8 + 2] ^= 0x80; // a payload byte inside IDAT: its CRC no longer matches
    expect(() => decodePng(badIdatData)).toThrow(/CRC mismatch in chunk "IDAT"/);
  });

  test("unsupported colour type / bit depth combinations", () => {
    const cases: Array<[number, number]> = [
      [2, 4],
      [3, 16],
      [0, 3],
      [6, 4],
      [4, 1],
      [1, 8],
      [5, 8],
      [7, 8],
      [0, 0],
    ];
    for (const [colorType, bitDepth] of cases) {
      expect(() => decodePng(png(ihdr(1, 1, bitDepth, colorType), idat(concat([[0, 0, 0, 0, 0]])), IEND))).toThrow(
        new RegExp(`unsupported colour type ${colorType} / bit depth ${bitDepth}`),
      );
    }
  });

  test("bad signature", () => {
    expect(() => decodePng(new Uint8Array(0))).toThrow(PngError);
    const notPng = Uint8Array.from(valid);
    notPng[0] = 0x88;
    expect(() => decodePng(notPng)).toThrow(/signature/);
  });

  test("bad IHDR contents", () => {
    expect(() => decodePng(png(ihdr(0, 1, 8, 6), IEND))).toThrow(/dimensions/);
    expect(() => decodePng(png(ihdr(1, 0, 8, 6), IEND))).toThrow(/dimensions/);
    expect(() => decodePng(png(chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 1, 0, 0]), IEND))).toThrow(/compression method/);
    expect(() => decodePng(png(chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 1, 0]), IEND))).toThrow(/filter method/);
    expect(() => decodePng(png(chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 2]), IEND))).toThrow(/interlace method/);
    expect(() => decodePng(png(chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6]), IEND))).toThrow(/13 bytes/);
    expect(() => decodePng(png(IEND))).toThrow(/first chunk must be IHDR/);
  });

  test("indexed image without PLTE", () => {
    expect(() => decodePng(png(ihdr(1, 1, 8, 3), idat(concat([[0, 0]])), IEND))).toThrow(/PLTE/);
    expect(() => decodePng(png(ihdr(1, 1, 8, 3), chunk("PLTE", [1, 2]), idat(concat([[0, 0]])), IEND))).toThrow(/PLTE/);
  });

  test("tRNS problems", () => {
    expect(() => decodePng(png(ihdr(1, 1, 8, 6), chunk("tRNS", [0, 0]), idat(concat([[0, 1, 2, 3, 4]])), IEND))).toThrow(/tRNS/);
    expect(() => decodePng(png(ihdr(1, 1, 8, 0), chunk("tRNS", [0]), idat(concat([[0, 1]])), IEND))).toThrow(/tRNS/);
    expect(() => decodePng(png(ihdr(1, 1, 8, 3), chunk("PLTE", [1, 2, 3]), chunk("tRNS", [0, 0]), idat(concat([[0, 0]])), IEND))).toThrow(/tRNS/);
  });

  test("IDAT data too short for the image", () => {
    expect(() => decodePng(png(ihdr(4, 4, 8, 6), idat(new Uint8Array(2 * 17)), IEND))).toThrow(/too short/);
    expect(() => decodePng(png(ihdr(4, 4, 8, 6, 1), idat(new Uint8Array(10)), IEND))).toThrow(/too short/);
  });

  test("a header claiming a gigantic image is refused before anything is allocated", () => {
    // 60000x60000 RGBA needs ~14.4 GB of filtered scanlines, past what zlib will
    // produce, so it must fail on the declared geometry rather than by inflating
    // or allocating first.
    expect(() => decodePng(png(ihdr(60000, 60000, 8, 6), idat(new Uint8Array(64)), IEND))).toThrow(/too large to decode/);
  });

  test("IDAT that expands past the declared geometry is refused (decompression bomb)", () => {
    // Filtered bytes an 8-bit RGBA image of this size holds: one filter byte + 4 bytes per pixel, per row.
    const holds = (w: number, h: number): number => (w * 4 + 1) * h;
    // ~8 MB of zeros, which deflate to a few kB: a small file that expands enormously.
    const bomb = idat(new Uint8Array(holds(1024, 2048)));

    // A 1x1 image holds 5 bytes, so this must be refused rather than inflated.
    expect(() => decodePng(png(ihdr(1, 1, 8, 6), bomb, IEND))).toThrow(/expands past what a 1x1 image can hold/);
    // The bound is exact: one row short is still refused...
    expect(() => decodePng(png(ihdr(1024, 2047, 8, 6), bomb, IEND))).toThrow(/expands past what a 1024x2047 image can hold/);
    // ...and the geometry that holds exactly this payload decodes.
    expect(() => decodePng(png(ihdr(1024, 2048, 8, 6), bomb, IEND))).not.toThrow();
  });

  test("no IDAT at all", () => {
    expect(() => decodePng(png(ihdr(1, 1, 8, 6), IEND))).toThrow(/IDAT/);
  });

  test("invalid filter type byte", () => {
    expect(() => decodePng(png(ihdr(1, 2, 8, 6), idat(concat([[0, 1, 2, 3, 4, 5, 1, 2, 3, 4]])), IEND))).toThrow(/filter type 5 on scanline 1/);
  });

  test("corrupt zlib stream", () => {
    expect(() => decodePng(png(ihdr(1, 1, 8, 6), chunk("IDAT", [1, 2, 3, 4, 5, 6]), IEND))).toThrow(/inflate/);
  });

  test("unknown critical chunk", () => {
    expect(() => decodePng(png(ihdr(1, 1, 8, 6), chunk("ABCD", [1]), idat(concat([[0, 1, 2, 3, 4]])), IEND))).toThrow(/critical chunk "ABCD"/);
  });

  test("corrupt chunk type bytes", () => {
    const broken = Uint8Array.from(valid);
    broken[13] = 0x00; // the 'H' of IHDR
    expect(() => decodePng(broken)).toThrow(/chunk type/);
  });

  test("errors are PngError instances with a PNG: prefix", () => {
    let caught: unknown;
    try {
      decodePng(valid.subarray(0, 30));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PngError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.startsWith("PNG: ")).toBe(true);
    expect((caught as Error).name).toBe("PngError");
  });

  test("encoder rejects inconsistent input", () => {
    expect(() => encodePng({ width: 2, height: 2, rgba: new Uint8Array(15) })).toThrow(/expected 16/);
    expect(() => encodePng({ width: 0, height: 2, rgba: new Uint8Array(0) })).toThrow(/dimensions/);
    expect(() => encodePng({ width: 1.5, height: 2, rgba: new Uint8Array(12) })).toThrow(/dimensions/);
    expect(() => encodePng(randomImage(1, 1, 1), { level: 10 })).toThrow(/level/);
    expect(() => encodePng(randomImage(1, 1, 1), { level: -1 })).toThrow(/level/);
    expect(() => encodePng(randomImage(1, 1, 1), { level: 2.5 })).toThrow(/level/);
  });
});
