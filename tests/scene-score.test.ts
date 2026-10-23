import { expect, test } from "bun:test";
import { buildSampleOffsets, luma, meanAbsLumaDiff, RESET_SCENE_SCORE, SceneCutDetector, sparseLuma } from "../src/pipeline/scene-score.ts";

function solid(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

test("mean abs luma diff over the sparse grid: identical frames 0, black to white 255", () => {
  const width = 96;
  const height = 64;
  const offsets = buildSampleOffsets(width, height);
  const black = sparseLuma(solid(width, height, 0, 0, 0), offsets);
  const white = sparseLuma(solid(width, height, 255, 255, 255), offsets);
  expect(meanAbsLumaDiff(black, black)).toBe(0);
  expect(meanAbsLumaDiff(black, white)).toBeCloseTo(255, 3);
});

test("the luma weights add up to 1, so a grey pixel's luma is its grey level", () => {
  for (const level of [0, 1, 100, 254, 255]) expect(luma(level, level, level)).toBeCloseTo(level, 9);
});

test("the sample grid is about 48x27 and starts half a step in", () => {
  expect(buildSampleOffsets(1920, 1080)).toHaveLength(48 * 27);
  expect(buildSampleOffsets(1920, 1080)[0]).toBe((20 * 1920 + 20) * 4); // steps of 40 px, first sample at 20
  expect(buildSampleOffsets(2, 2)).toHaveLength(4); // a tiny frame is sampled at every pixel
});

const grey = (level: number): Uint8Array => solid(96, 64, level, level, level);

test("SceneCutDetector never calls the first frame a cut, and needs a mean step above 40 luma units", () => {
  const detector = new SceneCutDetector(96, 64);
  expect(detector.isCut(grey(100))).toBe(false); // nothing to compare with yet
  expect(detector.isCut(grey(140))).toBe(false); // a step of exactly 40 is not above it
  expect(detector.isCut(grey(139))).toBe(false); // back down by 1
  expect(detector.isCut(grey(180))).toBe(true); // a step of 41 is
});

test("SceneCutDetector compares each frame with the one before it, not with the first", () => {
  const detector = new SceneCutDetector(96, 64);
  for (const level of [10, 40, 70, 100, 130]) expect(detector.isCut(grey(level)), String(level)).toBe(false); // steps of 30 add up to 120
});

test("the guide resets on the first frame and on each cut, and reports only cuts as scene cuts", () => {
  const detector = new SceneCutDetector(96, 64);
  expect(detector.guide(grey(100), 0)).toEqual({ reset: true, sceneCut: false });
  expect(detector.guide(grey(100), 1)).toEqual({ reset: false, sceneCut: false });
  expect(detector.guide(grey(200), 2)).toEqual({ reset: true, sceneCut: true });
  expect(detector.guide(grey(200), 3)).toEqual({ reset: false, sceneCut: false });
});

test("the two reset thresholds are not the same: a job with a motion estimator resets later than one without", () => {
  // The detector's 40 is pinned by the test above; this pins the estimator's, so that merging them is a decision made with a measurement.
  expect(RESET_SCENE_SCORE * 255).toBeCloseTo(61.2, 9);
});
