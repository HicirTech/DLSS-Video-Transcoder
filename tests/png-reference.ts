/**
 * Test-side PNG helpers. Deliberately independent of src/codec/png/: own CRC table, DataView-based
 * big-endian writes, the encoder-side filter definitions from the specification, and an Adam7 pass
 * builder, so that the two implementations check each other.
 */
import { expect } from "bun:test";
import { deflateSync as nodeDeflate } from "node:zlib";
import { PNG_SIGNATURE } from "../src/codec/png/chunks.ts";
import type { RgbaImage } from "../src/codec/png/types.ts";

const REF_CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  REF_CRC_TABLE.push(c >>> 0);
}

/** Plain byte-at-a-time CRC-32 as described in the PNG specification's annex. */
export function refCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = REF_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function concat(parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
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
export function chunk(type: string, data: ArrayLike<number> = []): Uint8Array<ArrayBuffer> {
  const body = Uint8Array.from(data);
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, refCrc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function ihdr(width: number, height: number, bitDepth: number, colorType: number, interlace = 0): Uint8Array<ArrayBuffer> {
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

export function idat(filteredScanlines: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return chunk("IDAT", new Uint8Array(nodeDeflate(filteredScanlines)));
}

/** The IHDR fields of an encoded file, read from the bytes: signature (8), chunk length (4) and type (4) come first. */
export function readIhdr(bytes: Uint8Array): Record<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    compressionMethod: bytes[26],
    filterMethod: bytes[27],
    interlaceMethod: bytes[28],
  };
}

export const IEND = chunk("IEND");

export function png(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concat([PNG_SIGNATURE, ...chunks]);
}

export function u16(v: number): number[] {
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

export interface ImageSpec {
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
export function buildImageData(spec: ImageSpec): Uint8Array<ArrayBuffer> {
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
export function expectedRgba(width: number, height: number, pixel: (x: number, y: number) => number[]): Uint8Array {
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

export function randomBytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  const next = makeRng(seed);
  for (let i = 0; i < length; i++) out[i] = next() & 0xff;
  return out;
}

export function randomImage(width: number, height: number, seed: number): RgbaImage {
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
export function syntheticFrame(width: number, height: number, seed: number, noiseBits = 2): RgbaImage {
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
export function bandedFrame(width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set([(x >> 4) * 16, (y >> 4) * 16, 128, 255], (y * width + x) * 4);
  }
  return { width, height, rgba };
}

/** Index of the first differing byte, or -1 when equal (far cheaper than toEqual on multi-megabyte arrays). */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

export function expectSameImage(actual: RgbaImage, width: number, height: number, rgba: Uint8Array): void {
  expect(actual.width).toBe(width);
  expect(actual.height).toBe(height);
  expect(actual.rgba.length).toBe(width * height * 4);
  expect(firstDifference(actual.rgba, rgba)).toBe(-1);
}
