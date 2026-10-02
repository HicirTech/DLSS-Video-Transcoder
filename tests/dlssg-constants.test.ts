/**
 * The synthetic camera and plane depth fed to DLSS Frame Generation. The runtime rejects missing
 * matrices but reports nothing about their values, so the inverse and the row-major layout are
 * checked here.
 */
import { describe, expect, test } from "bun:test";
import { dlssgIntervalConstants, type RowMajorMatrix4 } from "../src/pipeline/dlssg-constants.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(left: RowMajorMatrix4, right: RowMajorMatrix4): number[] {
  const product: number[] = [];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += left[row * 4 + k]! * right[k * 4 + column]!;
      product.push(sum);
    }
  }
  return product;
}

/** Row vector times matrix, the post-multiplied convention, then the perspective divide. */
function projectedDepth(viewToClip: RowMajorMatrix4, viewDistance: number): number {
  const clipZ = viewDistance * viewToClip[10]! + viewToClip[14]!;
  const clipW = viewDistance * viewToClip[11]! + viewToClip[15]!;
  return clipZ / clipW;
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, digits: number): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]!).toBeCloseTo(expected[i]!, digits);
}

describe("dlssgIntervalConstants", () => {
  const frames = [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 720, height: 1280 },
  ];

  test("ClipToCameraView is the inverse of CameraViewToClip, both ways round", () => {
    for (const frame of frames) {
      const constants = dlssgIntervalConstants(frame);
      expectClose(multiply(constants.cameraViewToClip, constants.clipToCameraView), IDENTITY, 6);
      expectClose(multiply(constants.clipToCameraView, constants.cameraViewToClip), IDENTITY, 6);
    }
  });

  // 90 degree vertical FOV gives a y scale of 1/tan(45) = 1; x divides by the aspect ratio.
  test("the projection is row-major: scales on the diagonal, w = view z in row 2", () => {
    const { cameraViewToClip } = dlssgIntervalConstants({ width: 1280, height: 720 });
    expect(cameraViewToClip).toBeInstanceOf(Float32Array);
    expect(cameraViewToClip.length).toBe(16);
    expect(cameraViewToClip[0]).toBeCloseTo(720 / 1280, 7);
    expect(cameraViewToClip[5]).toBeCloseTo(1, 7);
    expect(cameraViewToClip[11]).toBe(1);
    expect(cameraViewToClip[14]).toBeLessThan(0);
    expect(cameraViewToClip[15]).toBe(0);
  });

  test("near and far map to depth 0 and 1", () => {
    const { cameraViewToClip } = dlssgIntervalConstants({ width: 1280, height: 720 });
    expect(projectedDepth(cameraViewToClip, 1)).toBeCloseTo(0, 6);
    expect(projectedDepth(cameraViewToClip, 100)).toBeCloseTo(1, 6);
  });

  // By hand: far/(far-near) * (1 - near/distance) = 100/99 * (1 - 1/10) = 0.9090909...
  test("the plane depth is the hand value at distance 10, and what the projection gives there", () => {
    const { cameraViewToClip, planeDepth } = dlssgIntervalConstants({ width: 1280, height: 720 });
    expect(planeDepth).toBeCloseTo(0.909091, 6);
    expect(planeDepth).toBeCloseTo((100 / 99) * 0.9, 12);
    expect(projectedDepth(cameraViewToClip, 10)).toBeCloseTo(planeDepth, 6);
  });

  test("the plane is not at the far plane, which the runtime handles differently", () => {
    const { planeDepth } = dlssgIntervalConstants({ width: 1280, height: 720 });
    expect(planeDepth).toBeGreaterThan(0);
    expect(planeDepth).toBeLessThan(0.99);
  });

  test("the static-camera and lens matrices are identity", () => {
    const constants = dlssgIntervalConstants({ width: 1280, height: 720 });
    for (const matrix of [constants.clipToPrevClip, constants.prevClipToClip, constants.clipToLensClip]) {
      expect(Array.from(matrix)).toEqual(IDENTITY);
    }
  });
});
