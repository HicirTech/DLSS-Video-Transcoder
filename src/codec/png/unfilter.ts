/** Reverses the five PNG scanline filters in place, as the specification defines them. */
import { PngError } from "./types.ts";

/**
 * Reverses one scanline filter in place. `cur` is the first data byte of the line (just after the filter
 * byte); `prev[prevOff ..]` is the already reconstructed line above (or zeros for the first line of a pass).
 */
export function unfilterRow(
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
