/**
 * The CUDA copy wrappers (src/native/cuda.ts) hand the driver a host address and byte counts: a count the host
 * buffer does not cover is refused before the driver is reached, so these run without a GPU.
 */
import { expect, test } from "bun:test";
import { cudaMemcpy2DDtoH, cudaMemcpy2DHtoD, cudaMemcpyHtoD } from "../src/native/cuda.ts";

const PITCH = 64;
const ROW_BYTES = 48;
const ROWS = 3;
/** The host bytes ROWS rows of ROW_BYTES at PITCH span: every row but the last takes a whole pitch. */
const SPAN = (ROWS - 1) * PITCH + ROW_BYTES;

test("a host-to-device copy of more bytes than the host buffer holds is refused", () => {
  expect(() => cudaMemcpyHtoD(0n, new Uint8Array(16), 17)).toThrow(RangeError);
});

test("a 2D copy whose rows reach one byte past the host buffer is refused, in either direction", () => {
  const short = new Uint8Array(SPAN - 1);
  expect(() => cudaMemcpy2DHtoD({ src: short, srcPitch: PITCH, dstDevice: 0n, dstPitch: PITCH, widthBytes: ROW_BYTES, height: ROWS })).toThrow(RangeError);
  expect(() => cudaMemcpy2DDtoH({ dst: short, dstPitch: PITCH, srcDevice: 0n, srcPitch: PITCH, widthBytes: ROW_BYTES, height: ROWS })).toThrow(RangeError);
});

test("a 2D copy whose rows are wider than the host pitch is refused", () => {
  const roomy = new Uint8Array(SPAN * 4);
  expect(() => cudaMemcpy2DHtoD({ src: roomy, srcPitch: ROW_BYTES - 1, dstDevice: 0n, dstPitch: PITCH, widthBytes: ROW_BYTES, height: ROWS })).toThrow(RangeError);
});
