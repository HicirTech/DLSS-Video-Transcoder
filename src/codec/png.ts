/**
 * Dependency-free PNG codec for Bun.
 *
 * Written from the PNG specification (ISO/IEC 15948 / W3C PNG, 3rd edition):
 *   - 8-byte signature and chunk framing (length, type, data, CRC-32 over type + data)
 *   - IHDR, PLTE, tRNS, IDAT and IEND are interpreted; every other chunk (gAMA, iCCP, sRGB, tEXt, ...) is skipped
 *   - all colour types (0 greyscale, 2 RGB, 3 indexed, 4 grey+alpha, 6 RGBA) at every bit depth the
 *     specification allows for them (1, 2, 4, 8, 16)
 *   - the five scanline filters (None, Sub, Up, Average, Paeth) and Adam7 interlacing
 *   - the zlib stream itself is handled by Bun.inflateSync / Bun.deflateSync
 *
 * Decoded images are always 8-bit RGBA; 16-bit samples are reduced by keeping their high byte.
 * Encoded images are always 8-bit RGBA (colour type 6), filter type 0 on every scanline, a single IDAT chunk.
 */
import { deflateSync as nodeDeflate, inflateSync as nodeInflate } from "node:zlib";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An 8-bit RGBA raster: `rgba` holds exactly `width * height * 4` bytes, row-major, top row first, no padding. */
export interface RgbaImage {
  /** Width in pixels (>= 1). */
  width: number;
  /** Height in pixels (>= 1). */
  height: number;
  /** R, G, B, A for each pixel, left to right, top to bottom. */
  rgba: Uint8Array;
}

/** PNG colour types: 0 greyscale, 2 truecolour, 3 indexed-colour, 4 greyscale + alpha, 6 truecolour + alpha. */
export type PngColorType = 0 | 2 | 3 | 4 | 6;

/** The fields of the IHDR chunk. */
export interface PngHeader {
  width: number;
  height: number;
  /** Bits per sample (per palette index for colour type 3): 1, 2, 4, 8 or 16. */
  bitDepth: number;
  colorType: PngColorType;
  /** Always 0 (deflate/inflate) in a valid file. */
  compressionMethod: number;
  /** Always 0 (adaptive filtering with the five basic filters) in a valid file. */
  filterMethod: number;
  /** 0 = no interlace, 1 = Adam7. */
  interlaceMethod: number;
}

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

/** The 8-byte PNG file signature. Treat as read-only. */
export const PNG_SIGNATURE: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

/**
 * Lookup tables for the reflected CRC-32 polynomial 0xEDB88320 (the one used by PNG, zlib and gzip).
 * Table 0 is the classic byte-at-a-time table; table k is table 0 advanced by k more zero bytes, which
 * lets the main loop consume 8 input bytes per iteration ("slicing-by-8").
 */
const CRC_TABLES: Uint32Array = buildCrcTables();

function buildCrcTables(): Uint32Array {
  const t = new Uint32Array(8 * 256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    let c = t[i];
    for (let k = 1; k < 8; k++) {
      c = (t[c & 0xff] ^ (c >>> 8)) >>> 0;
      t[k * 256 + i] = c;
    }
  }
  return t;
}

/**
 * CRC-32 (IEEE 802.3, as used by PNG chunks) of `bytes`.
 *
 * `seed` is the CRC of the data that logically precedes `bytes`, so a stream can be checksummed in pieces:
 * `crc32(b, crc32(a)) === crc32(concat(a, b))`. The result is an unsigned 32-bit integer.
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  const t = CRC_TABLES;
  const n = bytes.length;
  let c = ~seed;
  let i = 0;
  const end8 = n - (n & 7);
  for (; i < end8; i += 8) {
    const w1 = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    const w2 = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    c =
      t[1792 + (w1 & 0xff)] ^
      t[1536 + ((w1 >>> 8) & 0xff)] ^
      t[1280 + ((w1 >>> 16) & 0xff)] ^
      t[1024 + (w1 >>> 24)] ^
      t[768 + (w2 & 0xff)] ^
      t[512 + ((w2 >>> 8) & 0xff)] ^
      t[256 + ((w2 >>> 16) & 0xff)] ^
      t[w2 >>> 24];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ---------------------------------------------------------------------------
// Byte helpers and chunk framing
// ---------------------------------------------------------------------------

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v >>> 24;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

function isAsciiLetter(ch: number): boolean {
  return (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a);
}

/** Packs a 4-character chunk type into the big-endian 32-bit integer it occupies in the file. */
function chunkTypeCode(type: string): number {
  if (type.length !== 4) throw new PngError(`chunk type "${type}" must be exactly 4 characters`);
  let code = 0;
  for (let i = 0; i < 4; i++) {
    const ch = type.charCodeAt(i);
    if (!isAsciiLetter(ch)) throw new PngError(`chunk type "${type}" must consist of ASCII letters`);
    code = (code << 8) | ch;
  }
  return code >>> 0;
}

function chunkTypeName(code: number): string {
  return String.fromCharCode((code >>> 24) & 0xff, (code >>> 16) & 0xff, (code >>> 8) & 0xff, code & 0xff);
}

const TYPE_IHDR = chunkTypeCode("IHDR");
const TYPE_PLTE = chunkTypeCode("PLTE");
const TYPE_IDAT = chunkTypeCode("IDAT");
const TYPE_IEND = chunkTypeCode("IEND");
const TYPE_tRNS = chunkTypeCode("tRNS");

/** Writes `length | type | data | crc` at `pos` and returns the position just after the chunk. */
function writeChunkInto(out: Uint8Array, pos: number, typeCode: number, data: Uint8Array | null): number {
  const len = data ? data.length : 0;
  writeU32(out, pos, len);
  writeU32(out, pos + 4, typeCode);
  if (data) out.set(data, pos + 8);
  writeU32(out, pos + 8 + len, crc32(out.subarray(pos + 4, pos + 8 + len)));
  return pos + 12 + len;
}

/**
 * Builds one complete PNG chunk (4-byte length, 4-byte type, data, 4-byte CRC) for hand-assembling files.
 * `type` must be four ASCII letters, e.g. `"tEXt"`.
 */
export function encodePngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeChunkInto(out, 0, chunkTypeCode(type), data);
  return out;
}

// ---------------------------------------------------------------------------
// Header validation
// ---------------------------------------------------------------------------

/** Number of samples per pixel for each colour type. */
function channelsFor(colorType: PngColorType): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
  }
}

/** True when the specification allows `bitDepth` for `colorType` (also narrows `colorType`). */
function isSupportedFormat(colorType: number, bitDepth: number): colorType is PngColorType {
  switch (colorType) {
    case 0:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
    case 3:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8;
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    default:
      return false;
  }
}

function parseIhdr(bytes: Uint8Array, dataStart: number, length: number): PngHeader {
  if (length !== 13) throw new PngError(`IHDR chunk must be 13 bytes long, got ${length}`);
  const width = readU32(bytes, dataStart);
  const height = readU32(bytes, dataStart + 4);
  const bitDepth = bytes[dataStart + 8];
  const colorType = bytes[dataStart + 9];
  const compressionMethod = bytes[dataStart + 10];
  const filterMethod = bytes[dataStart + 11];
  const interlaceMethod = bytes[dataStart + 12];
  if (width === 0 || height === 0) throw new PngError(`invalid image dimensions ${width}x${height}`);
  if (width > 0x7fffffff || height > 0x7fffffff) {
    throw new PngError(`image dimensions ${width}x${height} exceed the 2^31-1 limit`);
  }
  if (!isSupportedFormat(colorType, bitDepth)) {
    throw new PngError(`unsupported colour type ${colorType} / bit depth ${bitDepth} combination`);
  }
  if (compressionMethod !== 0) throw new PngError(`unsupported compression method ${compressionMethod}`);
  if (filterMethod !== 0) throw new PngError(`unsupported filter method ${filterMethod}`);
  if (interlaceMethod !== 0 && interlaceMethod !== 1) {
    throw new PngError(`unsupported interlace method ${interlaceMethod}`);
  }
  return { width, height, bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod };
}

// ---------------------------------------------------------------------------
// Chunk walking
// ---------------------------------------------------------------------------

interface ParsedFile {
  header: PngHeader;
  /** Raw PLTE payload (RGB triples), if present. */
  palette: Uint8Array | null;
  /** Raw tRNS payload, if present. */
  trns: Uint8Array | null;
  /** [start, end) byte ranges of every IDAT payload, in file order. */
  idat: Array<[number, number]>;
  idatLength: number;
}

/** True for the 8-byte PNG signature. Does not validate anything beyond it. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

function hex32(v: number): string {
  return "0x" + v.toString(16).padStart(8, "0");
}

/**
 * Walks the chunk stream, validating framing and CRCs. With `headerOnly` it stops right after IHDR,
 * otherwise it collects PLTE/tRNS/IDAT and requires IEND.
 */
function parseChunks(bytes: Uint8Array, headerOnly: boolean): ParsedFile {
  if (!isPng(bytes)) {
    throw new PngError(bytes.length < 8 ? "file is shorter than the 8-byte signature" : "bad signature, not a PNG file");
  }
  let header: PngHeader | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Array<[number, number]> = [];
  let idatLength = 0;
  let pos = 8;
  for (;;) {
    if (pos + 8 > bytes.length) {
      throw new PngError(header ? "truncated file: missing IEND chunk" : "truncated file: missing IHDR chunk");
    }
    const length = readU32(bytes, pos);
    const typeCode = readU32(bytes, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (
      !isAsciiLetter(typeCode >>> 24) ||
      !isAsciiLetter((typeCode >>> 16) & 0xff) ||
      !isAsciiLetter((typeCode >>> 8) & 0xff) ||
      !isAsciiLetter(typeCode & 0xff)
    ) {
      throw new PngError(`corrupt chunk type at byte ${pos + 4}`);
    }
    const name = chunkTypeName(typeCode);
    if (length > 0x7fffffff) throw new PngError(`chunk "${name}" declares an invalid length ${length}`);
    if (dataEnd + 4 > bytes.length) {
      throw new PngError(`truncated file: chunk "${name}" needs ${dataEnd + 4 - bytes.length} more bytes`);
    }
    const expected = readU32(bytes, dataEnd);
    const actual = crc32(bytes.subarray(pos + 4, dataEnd));
    if (expected !== actual) {
      throw new PngError(`CRC mismatch in chunk "${name}": stored ${hex32(expected)}, computed ${hex32(actual)}`);
    }
    if (header === null && typeCode !== TYPE_IHDR) throw new PngError(`first chunk must be IHDR, found "${name}"`);
    pos = dataEnd + 4;

    switch (typeCode) {
      case TYPE_IHDR:
        if (header !== null) throw new PngError("duplicate IHDR chunk");
        header = parseIhdr(bytes, dataStart, length);
        if (headerOnly) return { header, palette, trns, idat, idatLength };
        break;
      case TYPE_PLTE:
        if (palette !== null) throw new PngError("duplicate PLTE chunk");
        if (length === 0 || length % 3 !== 0 || length > 768) {
          throw new PngError(`PLTE length ${length} is not a multiple of 3 between 3 and 768`);
        }
        palette = bytes.subarray(dataStart, dataEnd);
        break;
      case TYPE_tRNS:
        if (trns !== null) throw new PngError("duplicate tRNS chunk");
        trns = bytes.subarray(dataStart, dataEnd);
        break;
      case TYPE_IDAT:
        idat.push([dataStart, dataEnd]);
        idatLength += length;
        break;
      case TYPE_IEND:
        if (idat.length === 0) throw new PngError("no IDAT chunk before IEND");
        return { header: header as PngHeader, palette, trns, idat, idatLength };
      default:
        // Critical chunks have an upper-case first letter; a decoder must not ignore one it does not know.
        if (typeCode >>> 24 < 0x61) throw new PngError(`unknown critical chunk "${name}"`);
        break; // ancillary chunk (gAMA, iCCP, tEXt, pHYs, ...): skipped
    }
  }
}

/** Validates the signature and IHDR chunk (including its CRC) and returns the header without decoding pixels. */
export function readPngHeader(bytes: Uint8Array): PngHeader {
  return parseChunks(bytes, true).header;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Adam7 passes as [xStart, yStart, xStep, yStep]. */
const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const NO_INTERLACE: ReadonlyArray<readonly [number, number, number, number]> = [[0, 0, 1, 1]];

/** Everything the per-row converter needs to know about the source format. */
interface PixelFormat {
  colorType: PngColorType;
  bitDepth: number;
  /** tRNS grey sample (raw value at the file's bit depth) or -1 when there is none. */
  trnsGray: number;
  /** tRNS RGB samples (raw values at the file's bit depth) or -1 when there is none. */
  trnsR: number;
  trnsG: number;
  trnsB: number;
  /** 256 RGBA entries for indexed images (unused entries are opaque black), otherwise null. */
  palette: Uint8Array | null;
}

/**
 * Decodes a PNG file into 8-bit RGBA.
 *
 * Supports every colour type / bit depth combination in the specification, tRNS transparency for
 * colour types 0, 2 and 3, Adam7 interlacing, all five filter types and multiple IDAT chunks.
 * 16-bit samples keep their high byte. Gamma, colour profiles and other ancillary data are ignored.
 *
 * @throws {PngError} on truncated, corrupt (bad CRC, bad zlib stream, bad filter byte, ...) or unsupported input.
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const parsed = parseChunks(bytes, false);
  const { width, height, bitDepth, colorType, interlaceMethod } = parsed.header;
  const format = buildPixelFormat(parsed);

  // All IDAT payloads together form one zlib stream.
  const compressed = new Uint8Array(parsed.idatLength);
  let cp = 0;
  for (const [start, end] of parsed.idat) {
    compressed.set(bytes.subarray(start, end), cp);
    cp += end - start;
  }
  let data: Uint8Array;
  try {
    // node:zlib, not Bun.inflateSync: Bun 1.4.2's inflate rejects valid multi-block streams
    // ("invalid stored block lengths") that real encoders (e.g. libpng) emit.
    data = new Uint8Array(nodeInflate(compressed));
  } catch (err) {
    throw new PngError(`zlib inflate failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Work out the geometry of every pass before allocating anything, so a corrupt header cannot make us
  // reserve a huge output raster for a file whose image data could never fill it.
  const bitsPerPixel = channelsFor(colorType) * bitDepth;
  const bpp = bitsPerPixel < 8 ? 1 : bitsPerPixel >> 3; // filter unit: bytes per pixel, rounded up to one
  const passes = interlaceMethod === 1 ? ADAM7 : NO_INTERLACE;
  const passWidths = new Int32Array(passes.length);
  const passHeights = new Int32Array(passes.length);
  let expectedBytes = 0;
  for (let p = 0; p < passes.length; p++) {
    const [x0, y0, dx, dy] = passes[p];
    const passWidth = x0 < width ? Math.ceil((width - x0) / dx) : 0;
    const passHeight = y0 < height ? Math.ceil((height - y0) / dy) : 0;
    passWidths[p] = passWidth;
    passHeights[p] = passHeight;
    // An empty pass contributes no bytes at all, not even filter bytes.
    if (passWidth > 0 && passHeight > 0) expectedBytes += (Math.ceil((passWidth * bitsPerPixel) / 8) + 1) * passHeight;
  }
  if (data.length < expectedBytes) {
    throw new PngError(`IDAT data is too short: got ${data.length} bytes, need ${expectedBytes}`);
  }

  let out: Uint8Array;
  try {
    out = new Uint8Array(width * height * 4);
  } catch {
    throw new PngError(`image ${width}x${height} is too large to decode`);
  }

  let offset = 0;
  for (let p = 0; p < passes.length; p++) {
    const passWidth = passWidths[p];
    const passHeight = passHeights[p];
    if (passWidth === 0 || passHeight === 0) continue;
    const [x0, y0, dx, dy] = passes[p];
    const lineBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    const stride = lineBytes + 1;
    const zeroRow = new Uint8Array(lineBytes); // the scanline "above" the first row of a pass is all zero
    const dstStride = dx * 4;
    for (let row = 0; row < passHeight; row++) {
      const cur = offset + row * stride + 1;
      const filterType = data[cur - 1];
      if (filterType !== 0) {
        if (row === 0) unfilterRow(filterType, data, cur, zeroRow, 0, lineBytes, bpp, row);
        else unfilterRow(filterType, data, cur, data, cur - stride, lineBytes, bpp, row);
      }
      convertRow(format, data, cur, out, ((y0 + row * dy) * width + x0) * 4, dstStride, passWidth);
    }
    offset += stride * passHeight;
  }
  return { width, height, rgba: out };
}

function buildPixelFormat(parsed: ParsedFile): PixelFormat {
  const { colorType, bitDepth } = parsed.header;
  const format: PixelFormat = { colorType, bitDepth, trnsGray: -1, trnsR: -1, trnsG: -1, trnsB: -1, palette: null };

  if (colorType === 3) {
    if (parsed.palette === null) throw new PngError("indexed-colour image has no PLTE chunk");
    const entries = parsed.palette.length / 3;
    if (entries > 1 << bitDepth) {
      throw new PngError(`PLTE has ${entries} entries, more than the ${1 << bitDepth} a ${bitDepth}-bit image can use`);
    }
    const table = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) table[i * 4 + 3] = 255;
    for (let i = 0; i < entries; i++) {
      table[i * 4] = parsed.palette[i * 3];
      table[i * 4 + 1] = parsed.palette[i * 3 + 1];
      table[i * 4 + 2] = parsed.palette[i * 3 + 2];
    }
    if (parsed.trns !== null) {
      if (parsed.trns.length > entries) {
        throw new PngError(`tRNS has ${parsed.trns.length} entries but the palette only has ${entries}`);
      }
      for (let i = 0; i < parsed.trns.length; i++) table[i * 4 + 3] = parsed.trns[i];
    }
    format.palette = table;
    return format;
  }

  if (parsed.trns !== null) {
    const trns = parsed.trns;
    if (colorType === 0) {
      if (trns.length !== 2) throw new PngError(`tRNS for a greyscale image must be 2 bytes, got ${trns.length}`);
      format.trnsGray = (trns[0] << 8) | trns[1];
    } else if (colorType === 2) {
      if (trns.length !== 6) throw new PngError(`tRNS for an RGB image must be 6 bytes, got ${trns.length}`);
      format.trnsR = (trns[0] << 8) | trns[1];
      format.trnsG = (trns[2] << 8) | trns[3];
      format.trnsB = (trns[4] << 8) | trns[5];
    } else {
      throw new PngError(`tRNS chunk is not allowed with colour type ${colorType}`);
    }
  }
  return format;
}

// ---------------------------------------------------------------------------
// Scanline filters (decoder side, in place)
// ---------------------------------------------------------------------------

/**
 * Reverses one scanline filter in place. `cur` is the first data byte of the line (just after the filter
 * byte); `prev[prevOff ..]` is the already reconstructed line above (or zeros for the first line of a pass).
 */
function unfilterRow(
  filterType: number,
  buf: Uint8Array,
  cur: number,
  prev: Uint8Array,
  prevOff: number,
  n: number,
  bpp: number,
  row: number,
): void {
  switch (filterType) {
    case 1:
      unfilterSub(buf, cur, n, bpp);
      break;
    case 2:
      unfilterUp(buf, cur, prev, prevOff, n);
      break;
    case 3:
      unfilterAverage(buf, cur, prev, prevOff, n, bpp);
      break;
    case 4:
      unfilterPaeth(buf, cur, prev, prevOff, n, bpp);
      break;
    default:
      throw new PngError(`invalid filter type ${filterType} on scanline ${row}`);
  }
}

function unfilterSub(buf: Uint8Array, cur: number, n: number, bpp: number): void {
  for (let i = cur + bpp, end = cur + n; i < end; i++) buf[i] = (buf[i] + buf[i - bpp]) & 0xff;
}

function unfilterUp(buf: Uint8Array, cur: number, prev: Uint8Array, prevOff: number, n: number): void {
  for (let i = 0; i < n; i++) buf[cur + i] = (buf[cur + i] + prev[prevOff + i]) & 0xff;
}

function unfilterAverage(buf: Uint8Array, cur: number, prev: Uint8Array, prevOff: number, n: number, bpp: number): void {
  let i = 0;
  for (; i < bpp; i++) buf[cur + i] = (buf[cur + i] + (prev[prevOff + i] >> 1)) & 0xff;
  for (; i < n; i++) buf[cur + i] = (buf[cur + i] + ((buf[cur + i - bpp] + prev[prevOff + i]) >> 1)) & 0xff;
}

function unfilterPaeth(buf: Uint8Array, cur: number, prev: Uint8Array, prevOff: number, n: number, bpp: number): void {
  let i = 0;
  // With no left neighbour (a = c = 0) the predictor is always the byte above.
  for (; i < bpp; i++) buf[cur + i] = (buf[cur + i] + prev[prevOff + i]) & 0xff;
  for (; i < n; i++) {
    const a = buf[cur + i - bpp];
    const b = prev[prevOff + i];
    const c = prev[prevOff + i - bpp];
    const p = a + b - c;
    let pa = p - a;
    if (pa < 0) pa = -pa;
    let pb = p - b;
    if (pb < 0) pb = -pb;
    let pc = p - c;
    if (pc < 0) pc = -pc;
    const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    buf[cur + i] = (buf[cur + i] + pred) & 0xff;
  }
}

// ---------------------------------------------------------------------------
// Sample conversion to 8-bit RGBA
// ---------------------------------------------------------------------------

/**
 * Converts one reconstructed scanline of `n` pixels starting at `src[s]` into RGBA at `dst[d]`, advancing the
 * destination by `dstStride` bytes per pixel (4 for contiguous output, 4 * xStep inside an Adam7 pass).
 */
function convertRow(
  fmt: PixelFormat,
  src: Uint8Array,
  s: number,
  dst: Uint8Array,
  d: number,
  dstStride: number,
  n: number,
): void {
  const depth = fmt.bitDepth;
  switch (fmt.colorType) {
    case 0: {
      const trns = fmt.trnsGray;
      if (depth === 8) {
        for (let x = 0; x < n; x++) {
          const v = src[s++];
          dst[d] = v;
          dst[d + 1] = v;
          dst[d + 2] = v;
          dst[d + 3] = v === trns ? 0 : 255;
          d += dstStride;
        }
      } else if (depth === 16) {
        for (let x = 0; x < n; x++) {
          const hi = src[s];
          const v = (hi << 8) | src[s + 1];
          s += 2;
          dst[d] = hi;
          dst[d + 1] = hi;
          dst[d + 2] = hi;
          dst[d + 3] = v === trns ? 0 : 255;
          d += dstStride;
        }
      } else {
        // 1, 2 or 4 bits per pixel, packed most significant bit first; scale to 0..255 exactly (255, 85, 17).
        const mask = (1 << depth) - 1;
        const scale = 255 / mask;
        let bit = 0;
        for (let x = 0; x < n; x++) {
          const v = (src[s + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
          bit += depth;
          const g = v * scale;
          dst[d] = g;
          dst[d + 1] = g;
          dst[d + 2] = g;
          dst[d + 3] = v === trns ? 0 : 255;
          d += dstStride;
        }
      }
      break;
    }
    case 2: {
      const tr = fmt.trnsR;
      const tg = fmt.trnsG;
      const tb = fmt.trnsB;
      if (depth === 8) {
        for (let x = 0; x < n; x++) {
          const r = src[s];
          const g = src[s + 1];
          const b = src[s + 2];
          s += 3;
          dst[d] = r;
          dst[d + 1] = g;
          dst[d + 2] = b;
          dst[d + 3] = r === tr && g === tg && b === tb ? 0 : 255;
          d += dstStride;
        }
      } else {
        for (let x = 0; x < n; x++) {
          const r = (src[s] << 8) | src[s + 1];
          const g = (src[s + 2] << 8) | src[s + 3];
          const b = (src[s + 4] << 8) | src[s + 5];
          s += 6;
          dst[d] = r >> 8;
          dst[d + 1] = g >> 8;
          dst[d + 2] = b >> 8;
          dst[d + 3] = r === tr && g === tg && b === tb ? 0 : 255;
          d += dstStride;
        }
      }
      break;
    }
    case 3: {
      const pal = fmt.palette as Uint8Array;
      if (depth === 8) {
        for (let x = 0; x < n; x++) {
          const p = src[s++] << 2;
          dst[d] = pal[p];
          dst[d + 1] = pal[p + 1];
          dst[d + 2] = pal[p + 2];
          dst[d + 3] = pal[p + 3];
          d += dstStride;
        }
      } else {
        const mask = (1 << depth) - 1;
        let bit = 0;
        for (let x = 0; x < n; x++) {
          const p = ((src[s + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask) << 2;
          bit += depth;
          dst[d] = pal[p];
          dst[d + 1] = pal[p + 1];
          dst[d + 2] = pal[p + 2];
          dst[d + 3] = pal[p + 3];
          d += dstStride;
        }
      }
      break;
    }
    case 4: {
      if (depth === 8) {
        for (let x = 0; x < n; x++) {
          const v = src[s];
          const a = src[s + 1];
          s += 2;
          dst[d] = v;
          dst[d + 1] = v;
          dst[d + 2] = v;
          dst[d + 3] = a;
          d += dstStride;
        }
      } else {
        for (let x = 0; x < n; x++) {
          const v = src[s];
          const a = src[s + 2];
          s += 4;
          dst[d] = v;
          dst[d + 1] = v;
          dst[d + 2] = v;
          dst[d + 3] = a;
          d += dstStride;
        }
      }
      break;
    }
    case 6: {
      if (depth === 8) {
        if (dstStride === 4) {
          dst.set(src.subarray(s, s + n * 4), d); // the common case: a straight copy
        } else {
          for (let x = 0; x < n; x++) {
            dst[d] = src[s];
            dst[d + 1] = src[s + 1];
            dst[d + 2] = src[s + 2];
            dst[d + 3] = src[s + 3];
            s += 4;
            d += dstStride;
          }
        }
      } else {
        for (let x = 0; x < n; x++) {
          dst[d] = src[s];
          dst[d + 1] = src[s + 2];
          dst[d + 2] = src[s + 4];
          dst[d + 3] = src[s + 6];
          s += 8;
          d += dstStride;
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

type ZlibLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Encodes an 8-bit RGBA image as a PNG (colour type 6, bit depth 8, no interlace).
 *
 * Every scanline uses filter type 0 and the whole zlib stream goes into one IDAT chunk, so the cost is
 * essentially one memcpy plus `Bun.deflateSync` at the requested level (default 6).
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

  // Filtered image data: one filter-type byte (0 = None) followed by the raw RGBA bytes of each row.
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
