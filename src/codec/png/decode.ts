/** PNG decoder: inflates under a limit derived from the header, then unfilters and converts each pass to 8-bit RGBA. */
import { inflateSync as nodeInflate } from "node:zlib";
import { channelsFor, parseChunks, type ParsedFile } from "./chunks.ts";
import { convertRow, type PixelFormat } from "./convert-row.ts";
import { PngError, type RgbaImage } from "./types.ts";
import { unfilterRow } from "./unfilter.ts";

/** zlib refuses a `maxOutputLength` above 2^32, so an image needing more filtered data than this cannot be decoded here. */
const MAX_INFLATE_BYTES = 4294967296;

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

/** Where each pass of the (possibly interlaced) image sits, as the geometry the header declares dictates. */
interface PassLayout {
  passes: ReadonlyArray<readonly [number, number, number, number]>;
  passWidths: Int32Array;
  passHeights: Int32Array;
  /** Filtered bytes that geometry accounts for: per row of every non-empty pass, one filter byte plus the pixels. */
  expectedBytes: number;
}

/**
 * Decodes a PNG file into 8-bit RGBA. Handles every colour type / bit depth combination the
 * specification allows, tRNS transparency for colour types 0, 2 and 3, Adam7, all five filter types and
 * multiple IDAT chunks. Gamma, colour profiles and other ancillary data are ignored.
 *
 * @throws {PngError} on truncated, corrupt (bad CRC, bad zlib stream, bad filter byte, ...) or unsupported input.
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const parsed = parseChunks(bytes);
  const { width, height, bitDepth, colorType, interlaceMethod } = parsed.header;
  const format = buildPixelFormat(parsed);

  const compressed = concatenateIdat(bytes, parsed);
  // Size every pass BEFORE inflating: the geometry the header declares is the only
  // legitimate amount of filtered data, so it doubles as the decompression limit and
  // stops a small file from expanding into an arbitrarily large buffer.
  const bitsPerPixel = channelsFor(colorType) * bitDepth;
  const layout = measurePasses(width, height, bitsPerPixel, interlaceMethod);
  const data = inflateFilteredData(compressed, layout.expectedBytes, width, height);

  let out: Uint8Array;
  try {
    out = new Uint8Array(width * height * 4);
  } catch {
    throw new PngError(`image ${width}x${height} is too large to decode`);
  }

  reconstructPasses(data, out, format, layout, width, bitsPerPixel);
  return { width, height, rgba: out };
}

function concatenateIdat(bytes: Uint8Array, parsed: ParsedFile): Uint8Array {
  // All IDAT payloads together form one zlib stream.
  const compressed = new Uint8Array(parsed.idatLength);
  let cp = 0;
  for (const [start, end] of parsed.idat) {
    compressed.set(bytes.subarray(start, end), cp);
    cp += end - start;
  }
  return compressed;
}

function measurePasses(width: number, height: number, bitsPerPixel: number, interlaceMethod: number): PassLayout {
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
  return { passes, passWidths, passHeights, expectedBytes };
}

function inflateFilteredData(compressed: Uint8Array, expectedBytes: number, width: number, height: number): Uint8Array {
  // Past this the filtered data alone would exceed what zlib will produce, so the
  // image cannot be decoded at all — say so now instead of inflating gigabytes first.
  if (expectedBytes > MAX_INFLATE_BYTES) {
    throw new PngError(`image ${width}x${height} is too large to decode: its scanlines alone would need ${expectedBytes} bytes`);
  }

  let data: Uint8Array;
  try {
    // node:zlib, not Bun.inflateSync: Bun 1.4.2's inflate rejects valid multi-block streams
    // ("invalid stored block lengths") that real encoders (e.g. libpng) emit.
    // maxOutputLength aborts inside zlib rather than after the memory is already gone.
    data = new Uint8Array(nodeInflate(compressed, { maxOutputLength: expectedBytes }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // zlib reports the cap as a Buffer-size error; say what actually happened.
    if (/larger than/i.test(message)) {
      throw new PngError(
        `IDAT expands past what a ${width}x${height} image can hold (${expectedBytes} bytes); the file declares a small image but carries a much larger compressed stream`,
      );
    }
    throw new PngError(`zlib inflate failed: ${message}`);
  }
  if (data.length < expectedBytes) {
    throw new PngError(`IDAT data is too short: got ${data.length} bytes, need ${expectedBytes}`);
  }
  return data;
}

/** Reverses the filters of every pass in place and writes each pixel to its place in the RGBA output. */
function reconstructPasses(
  data: Uint8Array,
  out: Uint8Array,
  format: PixelFormat,
  layout: PassLayout,
  width: number,
  bitsPerPixel: number,
): void {
  const bpp = bitsPerPixel < 8 ? 1 : bitsPerPixel >> 3; // filter unit: bytes per pixel, rounded up to one
  const { passes, passWidths, passHeights } = layout;
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
      unfilterScanline(data, cur, stride, zeroRow, lineBytes, bpp, row);
      convertRow(format, data, cur, out, ((y0 + row * dy) * width + x0) * 4, dstStride, passWidth);
    }
    offset += stride * passHeight;
  }
}

/** Reverses the filter of one scanline in place; filter type 0 leaves it as it is. */
function unfilterScanline(
  data: Uint8Array,
  cur: number,
  stride: number,
  zeroRow: Uint8Array,
  lineBytes: number,
  bpp: number,
  row: number,
): void {
  const filterType = data[cur - 1];
  if (filterType === 0) return;
  if (row === 0) unfilterRow(filterType, data, cur, zeroRow, 0, lineBytes, bpp, row);
  else unfilterRow(filterType, data, cur, data, cur - stride, lineBytes, bpp, row);
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
