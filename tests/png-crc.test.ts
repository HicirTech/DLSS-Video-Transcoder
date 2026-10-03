/** PNG signature detection and CRC-32 against a byte-at-a-time reference. */
import { describe, expect, test } from "bun:test";
import { PNG_SIGNATURE, isPng } from "../src/codec/png/chunks.ts";
import { crc32 } from "../src/codec/png/crc32.ts";
import { encodePng } from "../src/codec/png/encode.ts";
import { randomBytes, randomImage, refCrc32 } from "./png-reference.ts";

describe("isPng", () => {
  test("recognises the signature", () => {
    expect(isPng(PNG_SIGNATURE)).toBe(true);
    expect(isPng(encodePng(randomImage(1, 1, 1)))).toBe(true);
  });

  test("rejects other data", () => {
    expect(isPng(new Uint8Array(0))).toBe(false);
    expect(isPng(PNG_SIGNATURE.subarray(0, 7))).toBe(false);
    expect(isPng(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(false);
    const almost = Uint8Array.from(PNG_SIGNATURE);
    almost[7] = 0x0d;
    expect(isPng(almost)).toBe(false);
  });
});

describe("crc32", () => {
  test("matches the standard check values", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082); // every PNG ends with these 4 bytes
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test("matches a byte-at-a-time reference for many lengths and alignments", () => {
    const data = randomBytes(4096, 7);
    for (let len = 0; len <= 80; len++) expect(crc32(data.subarray(0, len))).toBe(refCrc32(data.subarray(0, len)));
    for (let offset = 0; offset < 9; offset++) {
      const view = data.subarray(offset, offset + 1001);
      expect(crc32(view)).toBe(refCrc32(view));
    }
    expect(crc32(data)).toBe(refCrc32(data));
  });

  test("chains through the seed argument", () => {
    const data = randomBytes(1000, 11);
    const a = data.subarray(0, 333);
    const b = data.subarray(333);
    expect(crc32(b, crc32(a))).toBe(crc32(data));
    expect(crc32(new Uint8Array(0), 0x12345678)).toBe(0x12345678);
  });
});
