import { describe, expect, test } from "bun:test";
import { deflateSync as nodeDeflate } from "node:zlib";
import {
  PNG_SIGNATURE,
  PngError,
  crc32,
  decodePng,
  encodePng,
  encodePngChunk,
  isPng,
  readPngHeader,
  type RgbaImage,
} from "../src/codec/png.ts";

// ===========================================================================
// Test-side helpers. Deliberately independent of src/codec/png.ts: own CRC table, DataView-based
// big-endian writes, the encoder-side filter definitions from the specification, and an Adam7 pass
// builder, so that the two implementations check each other.
// ===========================================================================

const REF_CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  REF_CRC_TABLE.push(c >>> 0);
}

/** Plain byte-at-a-time CRC-32 as described in the PNG specification's annex. */
function refCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = REF_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** One chunk: 4-byte big-endian length, 4-byte type, data, CRC-32 over type + data. */
function chunk(type: string, data: ArrayLike<number> = []): Uint8Array<ArrayBuffer> {
  const body = Uint8Array.from(data);
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, refCrc32(out.subarray(4, 8 + body.length)));
  return out;
}

function ihdr(width: number, height: number, bitDepth: number, colorType: number, interlace = 0): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = interlace;
  return chunk("IHDR", data);
}

function idat(filteredScanlines: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return chunk("IDAT", new Uint8Array(nodeDeflate(filteredScanlines)));
}

const IEND = chunk("IEND");

function png(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concat([PNG_SIGNATURE, ...chunks]);
}

function u16(v: number): number[] {
  return [v >> 8, v & 0xff];
}

/** Adam7 passes as [xStart, yStart, xStep, yStep], from the specification. */
const ADAM7_PASSES: ReadonlyArray<readonly number[]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** Packs one scanline's samples at the given bit depth (MSB first for sub-byte depths, big-endian for 16). */
function packSamples(samples: number[], bitDepth: number): Uint8Array<ArrayBuffer> {
  if (bitDepth === 16) {
    const out = new Uint8Array(samples.length * 2);
    samples.forEach((v, i) => {
      out[2 * i] = v >> 8;
      out[2 * i + 1] = v & 0xff;
    });
    return out;
  }
  if (bitDepth === 8) return Uint8Array.from(samples);
  const out = new Uint8Array(Math.ceil((samples.length * bitDepth) / 8));
  samples.forEach((v, i) => {
    const bit = i * bitDepth;
    out[bit >> 3] |= v << (8 - bitDepth - (bit & 7));
  });
  return out;
}

/** Encoder-side filter exactly as the specification defines it: Filt(x) = Orig(x) - Predictor(a, b, c). */
function filterScanline(type: number, raw: Uint8Array, prev: Uint8Array | null, bpp: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(raw.length + 1);
  out[0] = type;
  for (let i = 0; i < raw.length; i++) {
    const a = i >= bpp ? raw[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let predictor: number;
    switch (type) {
      case 0:
        predictor = 0;
        break;
      case 1:
        predictor = a;
        break;
      case 2:
        predictor = b;
        break;
      case 3:
        predictor = Math.floor((a + b) / 2);
        break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        break;
      }
      default:
        throw new Error(`bad filter type ${type}`);
    }
    out[i + 1] = (raw[i] - predictor) & 0xff;
  }
  return out;
}

interface ImageSpec {
  width: number;
  height: number;
  bitDepth: number;
  channels: number;
  interlaced?: boolean;
  /** Filter type for every scanline, or a function of the scanline's index within its pass. */
  filter?: number | ((row: number) => number);
  /** The raw sample values (at the file's bit depth) of pixel (x, y). */
  samples: (x: number, y: number) => number[];
}

/** Builds the filtered, still uncompressed image data stream for `spec`, pass by pass when interlaced. */
function buildImageData(spec: ImageSpec): Uint8Array<ArrayBuffer> {
  const passes: ReadonlyArray<readonly number[]> = spec.interlaced ? ADAM7_PASSES : [[0, 0, 1, 1]];
  const bpp = Math.max(1, Math.ceil((spec.channels * spec.bitDepth) / 8));
  const lines: Uint8Array[] = [];
  for (const pass of passes) {
    const [x0, y0, dx, dy] = pass;
    let prev: Uint8Array | null = null;
    let row = 0;
    for (let y = y0; y < spec.height; y += dy) {
      const samples: number[] = [];
      for (let x = x0; x < spec.width; x += dx) samples.push(...spec.samples(x, y));
      if (samples.length === 0) break; // the pass has no columns, hence no scanlines at all
      const raw = packSamples(samples, spec.bitDepth);
      const type = typeof spec.filter === "function" ? spec.filter(row) : (spec.filter ?? 0);
      lines.push(filterScanline(type, raw, prev, bpp));
      prev = raw;
      row++;
    }
  }
  return concat(lines);
}

/** Expected RGBA raster from a per-pixel function. */
function expectedRgba(width: number, height: number, pixel: (x: number, y: number) => number[]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(pixel(x, y), (y * width + x) * 4);
  }
  return out;
}

/** xorshift32; deterministic so failures are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

function randomBytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  const next = makeRng(seed);
  for (let i = 0; i < length; i++) out[i] = next() & 0xff;
  return out;
}

function randomImage(width: number, height: number, seed: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  const next = makeRng(seed);
  for (let i = 0; i < rgba.length; i += 4) {
    const v = next();
    rgba[i] = v & 0xff;
    rgba[i + 1] = (v >>> 8) & 0xff;
    rgba[i + 2] = (v >>> 16) & 0xff;
    rgba[i + 3] = v >>> 24;
  }
  return { width, height, rgba };
}

/** A photo-like frame: smooth gradients plus `noiseBits` bits of noise per channel, so deflate has realistic work to do. */
function syntheticFrame(width: number, height: number, seed: number, noiseBits = 2): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  const next = makeRng(seed);
  const noiseMask = (1 << noiseBits) - 1;
  let i = 0;
  for (let y = 0; y < height; y++) {
    const g = Math.round((y * 255) / (height - 1));
    for (let x = 0; x < width; x++) {
      const noise = next() & noiseMask;
      rgba[i] = ((x * 255) / (width - 1) + noise) & 0xff;
      rgba[i + 1] = (g + noise) & 0xff;
      rgba[i + 2] = (((x + y) * 255) / (width + height - 2) + noise) & 0xff;
      rgba[i + 3] = 255;
      i += 4;
    }
  }
  return { width, height, rgba };
}

/** 16x16 flat colour blocks: rows repeat, so deflate should shrink this by an order of magnitude. */
function bandedFrame(width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set([(x >> 4) * 16, (y >> 4) * 16, 128, 255], (y * width + x) * 4);
  }
  return { width, height, rgba };
}

/** Index of the first differing byte, or -1 when equal (far cheaper than toEqual on multi-megabyte arrays). */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function expectSameImage(actual: RgbaImage, width: number, height: number, rgba: Uint8Array): void {
  expect(actual.width).toBe(width);
  expect(actual.height).toBe(height);
  expect(actual.rgba.length).toBe(width * height * 4);
  expect(firstDifference(actual.rgba, rgba)).toBe(-1);
}

// ===========================================================================
// Signature and CRC
// ===========================================================================

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

// ===========================================================================
// Encoder / decoder round trips
// ===========================================================================

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
      expect(readPngHeader(bytes)).toEqual({
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

// ===========================================================================
// Hand-constructed files
// ===========================================================================

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
    const priv = encodePngChunk("prVt", Uint8Array.from([9, 9, 9]));
    const decoded = decodePng(png(ihdr(1, 1, 8, 6), gama, text, idat(rows), priv, IEND));
    expectSameImage(decoded, 1, 1, Uint8Array.from([1, 2, 3, 4]));
  });

  test("encodePngChunk matches the reference chunk writer", () => {
    const data = randomBytes(37, 5);
    expect(Array.from(encodePngChunk("tEXt", data))).toEqual(Array.from(chunk("tEXt", data)));
    expect(Array.from(encodePngChunk("IEND"))).toEqual(Array.from(IEND));
    expect(() => encodePngChunk("bad")).toThrow(PngError);
    expect(() => encodePngChunk("b4dd")).toThrow(PngError);
  });
});

// ===========================================================================
// Filter types
// ===========================================================================

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

// ===========================================================================
// Adam7 interlacing
// ===========================================================================

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

// ===========================================================================
// Error handling
// ===========================================================================

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
    expect(() => readPngHeader(badIhdrCrc)).toThrow(/CRC/);
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
    expect(() => readPngHeader(notPng)).toThrow(/signature/);
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
    // A header claiming a gigantic image with almost no data must fail on the data check, not on allocation.
    expect(() => decodePng(png(ihdr(60000, 60000, 8, 6), idat(new Uint8Array(64)), IEND))).toThrow(/too short/);
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

// ===========================================================================
// Performance sanity check
// ===========================================================================

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
