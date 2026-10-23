/** PNG decoder: inflates under a limit derived from the header, then unfilters and converts each pass to 8-bit RGBA. */
import { inflateSync as nodeInflate } from "node:zlib";
import { channelsFor, parseChunks, type ParsedFile, type PngHeader } from "./chunks.ts";
import { convertRow, type PixelFormat, type RowSpan } from "./convert-row.ts";
import { PngError, type RgbaImage } from "./types.ts";
import { isFilterType, unfilterRow } from "./unfilter.ts";

/** zlib refuses a `maxOutputLength` above 2^32, so an image needing more filtered data than this cannot be decoded here. */
const MAX_INFLATE_BYTES = 4294967296;

/** The pixels one pass carries: every xStep-th column from xStart, on every yStep-th row from yStart. */
type PassGrid = readonly [xStart: number, yStart: number, xStep: number, yStep: number];

/** The seven Adam7 passes, from the specification. */
const ADAM7: readonly PassGrid[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const NO_INTERLACE: readonly PassGrid[] = [[0, 0, 1, 1]];

/** Where each pass of the (possibly interlaced) image sits, as the geometry the header declares dictates. */
interface PassLayout {
  passes: readonly PassGrid[];
  passWidths: Int32Array;
  passHeights: Int32Array;
  /** Bytes of one scanline of each pass, its filter byte excluded; a long line of 8-byte pixels can pass 2^31. */
  passLineBytes: Float64Array;
  /** The filter unit: bytes per pixel, rounded up to one below 8 bits per pixel. */
  filterUnitBytes: number;
  /** Filtered bytes that geometry accounts for: per row of every non-empty pass, one filter byte plus the pixels. */
  expectedBytes: number;
}

/** The inflated scanlines, where the passes lie in them and how to read their pixels. */
interface FilteredImage {
  data: Uint8Array;
  layout: PassLayout;
  format: PixelFormat;
}

/** One pass's scanlines inside the inflated data. */
interface PassScan {
  data: Uint8Array;
  /** Offset of the pass's first filter byte in `data`. */
  passStart: number;
  /** Bytes of one scanline, its filter byte excluded. */
  lineBytes: number;
  filterUnitBytes: number;
  /** The all-zero line the specification puts above a pass's first row. */
  zeroLine: Uint8Array;
  /** The Adam7 pass an error names, counted from 1, or null when the image is not interlaced. */
  adam7Pass: number | null;
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
  const { header } = parsed;
  const format = buildPixelFormat(parsed);

  const compressed = concatenateIdat(bytes, parsed);
  // Size every pass BEFORE inflating: the geometry the header declares is the only
  // legitimate amount of filtered data, so it doubles as the decompression limit and
  // stops a small file from expanding into an arbitrarily large buffer.
  const layout = measurePasses(header);
  const data = inflateFilteredData(compressed, layout, header);

  const image: RgbaImage = { width: header.width, height: header.height, rgba: allocateRgba(header) };
  reconstructPasses({ data, layout, format }, image);
  return image;
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

function measurePasses({ width, height, colorType, bitDepth, interlaceMethod }: PngHeader): PassLayout {
  const bitsPerPixel = channelsFor(colorType) * bitDepth;
  const passes = interlaceMethod === 1 ? ADAM7 : NO_INTERLACE;
  const passWidths = new Int32Array(passes.length);
  const passHeights = new Int32Array(passes.length);
  const passLineBytes = new Float64Array(passes.length);
  let expectedBytes = 0;
  for (let p = 0; p < passes.length; p++) {
    const [xStart, yStart, xStep, yStep] = passes[p];
    const passWidth = xStart < width ? Math.ceil((width - xStart) / xStep) : 0;
    const passHeight = yStart < height ? Math.ceil((height - yStart) / yStep) : 0;
    passWidths[p] = passWidth;
    passHeights[p] = passHeight;
    passLineBytes[p] = Math.ceil((passWidth * bitsPerPixel) / 8);
    // An empty pass contributes no bytes at all, not even filter bytes.
    if (passWidth > 0 && passHeight > 0) expectedBytes += (passLineBytes[p] + 1) * passHeight;
  }
  const filterUnitBytes = bitsPerPixel < 8 ? 1 : bitsPerPixel >> 3;
  return { passes, passWidths, passHeights, passLineBytes, filterUnitBytes, expectedBytes };
}

function inflateFilteredData(compressed: Uint8Array, { expectedBytes }: PassLayout, { width, height }: PngHeader): Uint8Array {
  // Past this the filtered data alone would exceed what node:zlib will produce, so the
  // image cannot be decoded at all — say so now instead of inflating gigabytes first.
  if (expectedBytes > MAX_INFLATE_BYTES) {
    throw new PngError(
      `image ${width}x${height} is too large to decode: its scanlines alone would need ${expectedBytes} bytes, more than the ${MAX_INFLATE_BYTES} node:zlib can inflate; downscale it and try again`,
    );
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
        `IDAT expands past what a ${width}x${height} image can hold (${expectedBytes} bytes): the file is corrupt or its header understates the image size; re-export the PNG`,
      );
    }
    throw new PngError(`zlib inflate failed: ${message}`);
  }
  if (data.length < expectedBytes) {
    throw new PngError(`IDAT data is too short: got ${data.length} bytes, need ${expectedBytes}`);
  }
  return data;
}

function allocateRgba({ width, height }: PngHeader): Uint8Array {
  try {
    return new Uint8Array(width * height * 4);
  } catch {
    throw new PngError(`image ${width}x${height} is too large to decode: its ${width * height * 4}-byte RGBA buffer could not be allocated; downscale it and try again`);
  }
}

/** Reverses the filters of every pass in place and writes each pixel to its place in `image`. */
function reconstructPasses({ data, layout, format }: FilteredImage, image: RgbaImage): void {
  const { passes, passWidths, passHeights, passLineBytes, filterUnitBytes } = layout;
  let passStart = 0;
  for (let p = 0; p < passes.length; p++) {
    const passWidth = passWidths[p];
    const passHeight = passHeights[p];
    if (passWidth === 0 || passHeight === 0) continue;
    const [xStart, yStart, xStep, yStep] = passes[p];
    const lineBytes = passLineBytes[p];
    const scan: PassScan = { data, passStart, lineBytes, filterUnitBytes, zeroLine: new Uint8Array(lineBytes), adam7Pass: passes.length > 1 ? p + 1 : null };
    const span: RowSpan = { source: data, sourceOffset: 0, target: image.rgba, targetOffset: 0, targetPixelStride: xStep * 4, pixelCount: passWidth };
    for (let row = 0; row < passHeight; row++) {
      unfilterScanline(scan, row);
      span.sourceOffset = lineStart(scan, row);
      span.targetOffset = ((yStart + row * yStep) * image.width + xStart) * 4;
      convertRow(format, span);
    }
    passStart += (lineBytes + 1) * passHeight;
  }
}

/** Where row `row` of the pass starts in the data: just after its filter byte. */
function lineStart(scan: PassScan, row: number): number {
  return scan.passStart + row * (scan.lineBytes + 1) + 1;
}

/** Reverses the filter of one scanline in place; `row` counts within the pass. */
function unfilterScanline(scan: PassScan, row: number): void {
  const start = lineStart(scan, row);
  const filterType = scan.data[start - 1];
  if (!isFilterType(filterType)) {
    throw new PngError(`invalid filter type ${filterType} on scanline ${row}${scan.adam7Pass === null ? "" : ` of Adam7 pass ${scan.adam7Pass}`}`);
  }
  const line = scan.data.subarray(start, start + scan.lineBytes);
  const above = row === 0 ? scan.zeroLine : scan.data.subarray(start - scan.lineBytes - 1, start - 1);
  unfilterRow(filterType, { line, above }, scan.filterUnitBytes);
}

/** The pixel format the header, PLTE and tRNS describe; a PLTE or tRNS the specification forbids is a PngError. */
function buildPixelFormat(parsed: ParsedFile): PixelFormat {
  const { colorType, bitDepth } = parsed.header;
  const trns = parsed.trns;
  switch (colorType) {
    case 3:
      return { colorType, bitDepth, palette: paletteTable(parsed) };
    case 0:
      if (trns === null) return { colorType, bitDepth, transparentGrey: null };
      if (trns.length !== 2) throw new PngError(`tRNS for a greyscale image must be 2 bytes, got ${trns.length}`);
      return { colorType, bitDepth, transparentGrey: (trns[0] << 8) | trns[1] };
    case 2:
      if (trns === null) return { colorType, bitDepth, transparentRgb: null };
      if (trns.length !== 6) throw new PngError(`tRNS for an RGB image must be 6 bytes, got ${trns.length}`);
      return { colorType, bitDepth, transparentRgb: [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] };
    case 4:
    case 6:
      if (trns !== null) throw new PngError(`tRNS chunk is not allowed with colour type ${colorType}`);
      return { colorType, bitDepth };
  }
}

/** An indexed image's 256 RGBA entries: the PLTE colours, the tRNS alpha, and opaque black for unused entries. */
function paletteTable({ header, palette, trns }: ParsedFile): Uint8Array {
  if (palette === null) throw new PngError("indexed-colour image has no PLTE chunk");
  const entries = palette.length / 3;
  if (entries > 1 << header.bitDepth) {
    throw new PngError(`PLTE has ${entries} entries, more than the ${1 << header.bitDepth} a ${header.bitDepth}-bit image can use`);
  }
  const table = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) table[i * 4 + 3] = 255;
  for (let i = 0; i < entries; i++) {
    table[i * 4] = palette[i * 3];
    table[i * 4 + 1] = palette[i * 3 + 1];
    table[i * 4 + 2] = palette[i * 3 + 2];
  }
  if (trns !== null) {
    if (trns.length > entries) {
      throw new PngError(`tRNS has ${trns.length} entries but the palette only has ${entries}`);
    }
    for (let i = 0; i < trns.length; i++) table[i * 4 + 3] = trns[i];
  }
  return table;
}
