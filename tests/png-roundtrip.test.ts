/** Encoder and decoder round trips, the encoder's chunk layout and decoding time at 4K. */
import { describe, expect, test } from "bun:test";
import { PNG_SIGNATURE, isPng } from "../src/codec/png/chunks.ts";
import { decodePng } from "../src/codec/png/decode.ts";
import { encodePng } from "../src/codec/png/encode.ts";
import { bandedFrame, expectSameImage, randomImage, readIhdr, refCrc32, syntheticFrame } from "./png-reference.ts";

describe("round trip", () => {
  const sizes: Array<[number, number]> = [
    [1, 1],
    [3, 2],
    [17, 9],
    [256, 256],
    [1920, 1080],
  ];
  for (const [width, height] of sizes) {
    test(`${width}x${height} random RGBA`, () => {
      const image = randomImage(width, height, width * 1000 + height);
      const t0 = performance.now();
      const bytes = encodePng(image);
      const t1 = performance.now();
      const decoded = decodePng(bytes);
      const t2 = performance.now();
      expect(isPng(bytes)).toBe(true);
      expect(readIhdr(bytes)).toEqual({
        width,
        height,
        bitDepth: 8,
        colorType: 6,
        compressionMethod: 0,
        filterMethod: 0,
        interlaceMethod: 0,
      });
      expectSameImage(decoded, width, height, image.rgba);
      if (width * height >= 1_000_000) {
        console.log(`[timing] ${width}x${height} random: encode ${(t1 - t0).toFixed(1)} ms, decode ${(t2 - t1).toFixed(1)} ms, ${bytes.length} bytes`);
      }
    });
  }

  test("compression levels 0 and 9 both round-trip", () => {
    const image = randomImage(17, 9, 42);
    const stored = encodePng(image, { level: 0 });
    const best = encodePng(image, { level: 9 });
    expectSameImage(decodePng(stored), 17, 9, image.rgba);
    expectSameImage(decodePng(best), 17, 9, image.rgba);
    expect(stored.length).toBeGreaterThan(17 * 9 * 4);
  });

  test("compressible images actually compress and still round-trip", () => {
    const banded = bandedFrame(300, 200);
    const bandedBytes = encodePng(banded);
    expect(bandedBytes.length).toBeLessThan(banded.rgba.length / 10);
    expectSameImage(decodePng(bandedBytes), 300, 200, banded.rgba);

    const smooth = syntheticFrame(300, 200, 5, 0);
    const smoothBytes = encodePng(smooth);
    expect(smoothBytes.length).toBeLessThan(smooth.rgba.length);
    expectSameImage(decodePng(smoothBytes), 300, 200, smooth.rgba);
  });

  test("decodes from a view with a non-zero byteOffset", () => {
    const image = randomImage(9, 7, 3);
    const bytes = encodePng(image);
    const padded = new Uint8Array(bytes.length + 5);
    padded.set(bytes, 3);
    expectSameImage(decodePng(padded.subarray(3, 3 + bytes.length)), 9, 7, image.rgba);
  });

  test("encoder output has the expected chunk layout", () => {
    const bytes = encodePng(randomImage(2, 2, 9));
    expect(Array.from(bytes.subarray(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
    expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe("IHDR");
    expect(String.fromCharCode(...bytes.subarray(37, 41))).toBe("IDAT");
    expect(String.fromCharCode(...bytes.subarray(bytes.length - 8, bytes.length - 4))).toBe("IEND");
    // Every chunk's CRC must match the independent reference implementation.
    let pos = 8;
    while (pos < bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos);
      const length = view.getUint32(0);
      const stored = view.getUint32(8 + length);
      expect(stored).toBe(refCrc32(bytes.subarray(pos + 4, pos + 8 + length)));
      pos += 12 + length;
    }
    expect(pos).toBe(bytes.length);
  });
});

describe("performance", () => {
  test(
    "3840x2160 RGBA decodes in under 2 seconds",
    () => {
      const image = syntheticFrame(3840, 2160, 2024);
      const t0 = performance.now();
      const bytes = encodePng(image);
      const t1 = performance.now();
      const decoded = decodePng(bytes);
      const t2 = performance.now();
      console.log(`[timing] 3840x2160 synthetic: encode ${(t1 - t0).toFixed(1)} ms, decode ${(t2 - t1).toFixed(1)} ms, ${bytes.length} bytes`);
      expect(t2 - t1).toBeLessThan(2000);
      expectSameImage(decoded, 3840, 2160, image.rgba);
    },
    { timeout: 60_000 },
  );
});
