/** Reverses the five PNG scanline filters in place, as the specification defines them. */

/** The filter types the specification defines: 0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth. */
export type FilterType = 0 | 1 | 2 | 3 | 4;

/** Whether a scanline's filter byte names one of the five filter types. */
export function isFilterType(filterByte: number): filterByte is FilterType {
  return filterByte <= 4;
}

/** One scanline and the line above it, both without their filter bytes. */
export interface Scanlines {
  /** The line to reconstruct, in place. */
  line: Uint8Array;
  /** The already reconstructed line above, or zeros for the first line of a pass. */
  above: Uint8Array;
}

/**
 * Reverses `filterType` on one scanline in place. `bytesPerPixel` is the filter unit: the bytes of one pixel,
 * rounded up to one below 8 bits per pixel.
 */
export function unfilterRow(filterType: FilterType, { line, above }: Scanlines, bytesPerPixel: number): void {
  switch (filterType) {
    case 0:
      // None: the line is stored as it is.
      break;
    case 1:
      unfilterSub(line, bytesPerPixel);
      break;
    case 2:
      unfilterUp(line, above);
      break;
    case 3:
      unfilterAverage(line, above, bytesPerPixel);
      break;
    case 4:
      unfilterPaeth(line, above, bytesPerPixel);
      break;
  }
}

function unfilterSub(line: Uint8Array, bytesPerPixel: number): void {
  for (let i = bytesPerPixel; i < line.length; i++) line[i] = (line[i] + line[i - bytesPerPixel]) & 0xff;
}

function unfilterUp(line: Uint8Array, above: Uint8Array): void {
  for (let i = 0; i < line.length; i++) line[i] = (line[i] + above[i]) & 0xff;
}

function unfilterAverage(line: Uint8Array, above: Uint8Array, bytesPerPixel: number): void {
  let i = 0;
  for (; i < bytesPerPixel; i++) line[i] = (line[i] + (above[i] >> 1)) & 0xff;
  for (; i < line.length; i++) line[i] = (line[i] + ((line[i - bytesPerPixel] + above[i]) >> 1)) & 0xff;
}

function unfilterPaeth(line: Uint8Array, above: Uint8Array, bytesPerPixel: number): void {
  let i = 0;
  // With no left neighbour (a = c = 0) the predictor is always the byte above.
  for (; i < bytesPerPixel; i++) line[i] = (line[i] + above[i]) & 0xff;
  for (; i < line.length; i++) {
    const a = line[i - bytesPerPixel];
    const b = above[i];
    const c = above[i - bytesPerPixel];
    const p = a + b - c;
    let pa = p - a;
    if (pa < 0) pa = -pa;
    let pb = p - b;
    if (pb < 0) pb = -pb;
    let pc = p - c;
    if (pc < 0) pc = -pc;
    const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    line[i] = (line[i] + pred) & 0xff;
  }
}
