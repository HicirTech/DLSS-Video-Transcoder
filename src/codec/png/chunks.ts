/**
 * PNG container framing as the specification defines it (ISO/IEC 15948 / W3C PNG, 3rd edition): the signature,
 * the length/type/CRC chunk layout and the IHDR header.
 * The chunk walk interprets IHDR, PLTE, tRNS, IDAT and IEND and skips every other chunk.
 */
import { crc32 } from "./crc32.ts";
import { PngError, type PngColorType } from "./types.ts";

/** The 8-byte PNG file signature. Treat as read-only. */
export const PNG_SIGNATURE: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Byte helpers and chunk framing
// ---------------------------------------------------------------------------

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function writeU32(b: Uint8Array, o: number, v: number): void {
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
  let code = 0;
  for (let i = 0; i < 4; i++) code = (code << 8) | type.charCodeAt(i);
  return code >>> 0;
}

function chunkTypeName(code: number): string {
  return String.fromCharCode((code >>> 24) & 0xff, (code >>> 16) & 0xff, (code >>> 8) & 0xff, code & 0xff);
}

export const TYPE_IHDR = chunkTypeCode("IHDR");
const TYPE_PLTE = chunkTypeCode("PLTE");
export const TYPE_IDAT = chunkTypeCode("IDAT");
export const TYPE_IEND = chunkTypeCode("IEND");
const TYPE_tRNS = chunkTypeCode("tRNS");

/** Writes `length | type | data | crc` at `pos` and returns the position just after the chunk. */
export function writeChunkInto(out: Uint8Array, pos: number, typeCode: number, data: Uint8Array | null): number {
  const len = data ? data.length : 0;
  writeU32(out, pos, len);
  writeU32(out, pos + 4, typeCode);
  if (data) out.set(data, pos + 8);
  writeU32(out, pos + 8 + len, crc32(out.subarray(pos + 4, pos + 8 + len)));
  return pos + 12 + len;
}

// ---------------------------------------------------------------------------
// Header validation
// ---------------------------------------------------------------------------

/** The fields of the IHDR chunk. */
interface PngHeader {
  width: number;
  height: number;
  /** Bits per sample, or per palette index for colour type 3: 1, 2, 4, 8 or 16. */
  bitDepth: number;
  colorType: PngColorType;
  /** Always 0 (deflate) in a valid file. */
  compressionMethod: number;
  /** Always 0 (adaptive filtering with the five basic filters) in a valid file. */
  filterMethod: number;
  /** 0 = no interlace, 1 = Adam7. */
  interlaceMethod: number;
}

/** Number of samples per pixel for each colour type. */
export function channelsFor(colorType: PngColorType): number {
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

export interface ParsedFile {
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
 * Walks the chunk stream, validating framing and CRCs, collects PLTE/tRNS/IDAT and requires IEND.
 */
export function parseChunks(bytes: Uint8Array): ParsedFile {
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
