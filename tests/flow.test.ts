import { expect, test } from "bun:test";
import {
  DUPLICATE_SCENE_SCORE,
  RESET_SCENE_SCORE,
  buildMvExtractArgs,
  createMotionEstimator,
  encodeMotionR16G16,
  flowGridSize,
  floatToHalf,
  halfToFloat,
  resizeFlowBilinear,
  smallGray,
  sparseSceneScore,
} from "../src/pipeline/flow.ts";

// -- float16 encoder ----------------------------------------------------------

test("floatToHalf round-trips representative values through halfToFloat", () => {
  const exact = [0, 1, -1, 0.5, -0.5, 2, -2, 5, -5, 0.25, 1024, -1024, 65504];
  for (const v of exact) expect(halfToFloat(floatToHalf(v))).toBe(v);

  // Signed zero, non-representable values (nearest-even), and specials.
  expect(floatToHalf(-0)).toBe(0x8000);
  expect(halfToFloat(floatToHalf(0.1))).toBeCloseTo(0.1, 3);
  expect(halfToFloat(floatToHalf(-3.7))).toBeCloseTo(-3.7, 2);
  expect(floatToHalf(70000)).toBe(0x7c00); // overflow -> +Inf
  expect(floatToHalf(-70000)).toBe(0xfc00); // overflow -> -Inf
  expect(halfToFloat(floatToHalf(Infinity))).toBe(Infinity);
  expect(Number.isNaN(halfToFloat(floatToHalf(NaN)))).toBe(true);
  // Subnormal region survives the round trip approximately.
  expect(halfToFloat(floatToHalf(1e-5))).toBeCloseTo(1e-5, 6);
});

test("encodeMotionR16G16 packs an interleaved (x,y) field to halves (R=x, G=y)", () => {
  const motion = new Float32Array([3, -4, 0.5, -0.5]);
  const half = encodeMotionR16G16(motion);
  expect(half).toBeInstanceOf(Uint16Array);
  expect(half.length).toBe(4);
  for (let i = 0; i < motion.length; i++) expect(halfToFloat(half[i]!)).toBe(motion[i]!);
});

// -- scene score --------------------------------------------------------------

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

test("sparseSceneScore: identical frames ~0, black->white ~1", () => {
  const w = 96;
  const h = 64;
  const black = solid(w, h, 0, 0, 0);
  const white = solid(w, h, 255, 255, 255);
  expect(sparseSceneScore(black, black, w, h)).toBe(0);
  expect(sparseSceneScore(black, white, w, h)).toBeCloseTo(1, 5);
  expect(sparseSceneScore(black, white, w, h)).toBeGreaterThan(RESET_SCENE_SCORE);
});

// -- grid + resize helpers ----------------------------------------------------

test("flowGridSize caps the long side near flowWidth, rounds even, clamps to 64", () => {
  expect(flowGridSize(1920, 1080)).toEqual({ flowW: 640, flowH: 360 });
  expect(flowGridSize(96, 64)).toEqual({ flowW: 96, flowH: 64 }); // below cap: unchanged
  expect(flowGridSize(40, 30)).toEqual({ flowW: 64, flowH: 64 }); // clamped up to 64
});

test("resizeFlowBilinear is identity when sizes match", () => {
  const flow = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]); // 2x2 x,y
  const out = resizeFlowBilinear(flow, 2, 2, 2, 2);
  expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("smallGray reduces to a plain luma pass when the grid matches the source", () => {
  const gray = smallGray(solid(2, 1, 255, 0, 0), 2, 1, 2, 1);
  expect(gray[0]).toBeCloseTo(0.299 * 255, 4);
});

// -- estimator: reset / duplicate / real motion -------------------------------

/** A textured RGBA8 frame whose luma varies in both axes so blocks are distinct. */
function textured(width: number, height: number, shiftX: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - shiftX; // content at x came from sx in the unshifted image
      // Low-frequency in x (so a few-px shift stays well under the 0.24 scene-cut
      // threshold) with a static y term for vertical distinctiveness.
      const v = Math.round(128 + 40 * Math.sin(sx * 0.12) + 25 * Math.sin(y * 0.3));
      const o = (y * width + x) * 4;
      buf[o] = v;
      buf[o + 1] = v;
      buf[o + 2] = v;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

test("estimator forces reset with null motion on the first frame", () => {
  const est = createMotionEstimator(96, 64);
  const first = est.process(textured(96, 64, 0));
  expect(first.reset).toBe(true);
  expect(first.motion).toBeNull();
  expect(first.confidence).toBe(0);
  est.close();
});

test("estimator flags a duplicate frame: zero motion, no reset, confidence 1", () => {
  const est = createMotionEstimator(96, 64);
  const frame = textured(96, 64, 0);
  est.process(frame);
  const dup = est.process(frame); // identical
  expect(dup.duplicate).toBe(true);
  expect(dup.reset).toBe(false);
  expect(dup.motion).toBeNull();
  expect(dup.confidence).toBe(1);
  expect(dup.sceneScore).toBeLessThan(DUPLICATE_SCENE_SCORE);
  est.close();
});

test("estimator resets with null motion across a scene cut", () => {
  const est = createMotionEstimator(96, 64);
  est.process(solid(96, 64, 0, 0, 0));
  const cut = est.process(solid(96, 64, 255, 255, 255));
  expect(cut.reset).toBe(true);
  expect(cut.motion).toBeNull();
  expect(cut.sceneScore).toBeGreaterThan(RESET_SCENE_SCORE);
  est.close();
});

test("estimator recovers a +5px x shift as backward MV.x ~ -5, MV.y ~ 0", () => {
  const w = 96;
  const h = 64;
  const est = createMotionEstimator(w, h, { blockMatch: { block: 8, search: 8 } });
  est.process(textured(w, h, 0)); // previous
  const res = est.process(textured(w, h, 5)); // content shifted +5 in x
  expect(res.reset).toBe(false);
  expect(res.motion).not.toBeNull();
  expect(res.confidence).toBeCloseTo(1, 5);

  const mv = res.motion!;
  expect(mv.length).toBe(w * h * 2);
  // Average MV over an interior region clear of the border (no previous content
  // exists for the leftmost `shift` columns).
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 16; y < h - 16; y++) {
    for (let x = 16; x < w - 16; x++) {
      const o = (y * w + x) * 2;
      sx += mv[o]!;
      sy += mv[o + 1]!;
      n++;
    }
  }
  expect(sx / n).toBeCloseTo(-5, 0); // backward flow: current -> previous is -shift
  expect(Math.abs(sy / n)).toBeLessThan(1);
  est.close();
});

// -- ffmpeg boundary ----------------------------------------------------------

test("buildMvExtractArgs constructs export_mvs + mestimate args around the input", () => {
  const args = buildMvExtractArgs("ffmpeg", "in.mp4");
  expect(args[0]).toBe("ffmpeg");
  expect(args).toContain("+export_mvs");
  expect(args[args.indexOf("-i") + 1]).toBe("in.mp4");
  expect(args.some((a) => a.startsWith("mestimate"))).toBe(true);
});

test("selecting the ffmpeg backend yields a non-producing calc boundary", () => {
  const est = createMotionEstimator(96, 64, { backend: "ffmpeg" });
  est.process(textured(96, 64, 0)); // first frame: no calc yet
  expect(() => est.process(textured(96, 64, 3))).toThrow(/dense optical flow/);
  est.close();
});
