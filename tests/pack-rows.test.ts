/**
 * packRows (src/native/d3d12.ts), which copies tightly packed pixel rows into the pitched staging memory linearLayout
 * describes: rows land at their pitch, and the padding between them is left alone.
 */
import { expect, test } from "bun:test";
import { DXGI_FORMAT_R8G8B8A8_UNORM, linearLayout, packRows } from "../src/native/d3d12.ts";

const PADDING_BYTE = 0xee;

test("rows narrower than the pitch land one pitch apart, padding untouched", () => {
  const width = 3;
  const height = 2;
  const layout = linearLayout(width, height, DXGI_FORMAT_R8G8B8A8_UNORM);
  const pixels = Uint8Array.from({ length: layout.rowBytes * height }, (_, index) => index + 1);
  const target = new Uint8Array(layout.totalBytes).fill(PADDING_BYTE);

  packRows(target, pixels, layout, height);

  expect(layout.rowPitch).toBeGreaterThan(layout.rowBytes);
  expect([...target.subarray(0, layout.rowBytes)]).toEqual([...pixels.subarray(0, layout.rowBytes)]);
  expect([...target.subarray(layout.rowPitch, layout.rowPitch + layout.rowBytes)]).toEqual([...pixels.subarray(layout.rowBytes)]);
  expect(target[layout.rowBytes]).toBe(PADDING_BYTE);
});

test("rows as wide as the pitch are copied in one piece", () => {
  const width = 64;
  const height = 2;
  const layout = linearLayout(width, height, DXGI_FORMAT_R8G8B8A8_UNORM);
  const pixels = Uint8Array.from({ length: layout.rowBytes * height }, (_, index) => index % 251);
  const target = new Uint8Array(layout.totalBytes);

  packRows(target, pixels, layout, height);

  expect(layout.rowPitch).toBe(layout.rowBytes);
  expect([...target.subarray(0, pixels.byteLength)]).toEqual([...pixels]);
});
