import { describe, expect, test } from "bun:test";
import type { FlowBackend } from "../src/pipeline/flow-backend.ts";
import { createMotionEstimator } from "../src/pipeline/flow.ts";
import { allFinite, packFlowResizedR16G16, resizeFlowBilinear } from "../src/pipeline/flow-resize.ts";
import { bitsToHalf, encodeMotionR16G16 } from "../src/pipeline/half-float.ts";
import { floatToHalf, halfToFloat } from "./half-float.ts";

/** The estimator's original three-pass path: resize -> scale (float32 store) -> pack. */
function referencePack(flow: Float32Array, inW: number, inH: number, outW: number, outH: number): Uint16Array {
  const full = resizeFlowBilinear(flow, { width: inW, height: inH }, { width: outW, height: outH });
  const kx = outW / inW;
  const ky = outH / inH;
  for (let i = 0; i < outW * outH; i++) {
    full[i * 2] = full[i * 2]! * kx;
    full[i * 2 + 1] = full[i * 2 + 1]! * ky;
  }
  return encodeMotionR16G16(full);
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("bitsToHalf / encodeMotionR16G16", () => {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const bitsOf = (v: number) => {
    f32[0] = v;
    return u32[0]!;
  };

  test("bitsToHalf pins the IEEE-754 half encoding on edge values and rounding ties", () => {
    // Each pair checked once against Bun's Float16Array.
    const cases: [value: number, halfBits: number][] = [
      [0, 0x0000],
      [-0, 0x8000],
      [1, 0x3c00],
      [-1, 0xbc00],
      [0.1, 0x2e66],
      [-0.1, 0xae66],
      [65504, 0x7bff],
      [65520, 0x7c00], // a tie that rounds to even, past the largest half: overflows
      [70000, 0x7c00],
      [1e-8, 0x0000], // underflow
      [5.960464477539063e-8, 0x0001], // 2^-24, the smallest subnormal
      [6.103515625e-5, 0x0400], // 2^-14, the smallest normal
      [3.0517578125e-5, 0x0200], // 2^-15, a subnormal
      [1.0009765625, 0x3c01],
      [1.00048828125, 0x3c00], // tie to even
      [1.00146484375, 0x3c02], // tie to even, up
      [2.5, 0x4100],
      [-3.75, 0xc380],
      [1234.5678, 0x64d3],
      [Number.NaN, 0x7e00],
      [Number.POSITIVE_INFINITY, 0x7c00],
      [Number.NEGATIVE_INFINITY, 0xfc00],
    ];
    for (const [value, halfBits] of cases) expect(bitsToHalf(bitsOf(value)), String(value)).toBe(halfBits);
    expect(halfToFloat(0x3c02)).toBe(1.001953125);
    expect(Number.isNaN(halfToFloat(0x7e00))).toBe(true);
  });

  test("view-based encode equals element-wise floatToHalf on a random buffer", () => {
    const rnd = seeded(7);
    const motion = new Float32Array(10_001);
    for (let i = 0; i < motion.length; i++) motion[i] = (rnd() - 0.5) * 4000;
    motion[3] = Number.NaN;
    motion[9] = Number.POSITIVE_INFINITY;
    const fast = encodeMotionR16G16(motion);
    for (let i = 0; i < motion.length; i++) expect(fast[i]).toBe(floatToHalf(motion[i]!));
  });

  test("works on a Float32Array with a byte offset", () => {
    const backing = new Float32Array(8);
    for (let i = 0; i < 8; i++) backing[i] = i * 1.25 - 3;
    const view = backing.subarray(2, 7);
    const packed = encodeMotionR16G16(view);
    for (let i = 0; i < view.length; i++) expect(packed[i]).toBe(floatToHalf(view[i]!));
  });
});

describe("packFlowResizedR16G16", () => {
  test("bit-identical to resize + scale + pack for random grids", () => {
    const rnd = seeded(42);
    for (const [inW, inH, outW, outH] of [
      [16, 9, 64, 36],
      [20, 12, 33, 19],
      [64, 36, 128, 72],
      [3, 2, 7, 5],
      [1, 1, 4, 3],
    ] as const) {
      const flow = new Float32Array(inW * inH * 2);
      for (let i = 0; i < flow.length; i++) flow[i] = (rnd() - 0.5) * 30;
      expect(packFlowResizedR16G16(flow, { width: inW, height: inH }, { width: outW, height: outH })).toEqual(referencePack(flow, inW, inH, outW, outH));
    }
  });

  test("same size in and out is a pure pack", () => {
    const flow = new Float32Array([1.5, -2.25, 0.125, 3, -7, 0.5, 2, 2, 9, -9, 0.75, 0.25]);
    expect(packFlowResizedR16G16(flow, { width: 3, height: 2 }, { width: 3, height: 2 })).toEqual(encodeMotionR16G16(flow));
  });

  test("allFinite", () => {
    expect(allFinite(new Float32Array([0, 1, -2.5]))).toBe(true);
    expect(allFinite(new Float32Array([0, Number.NaN]))).toBe(false);
    expect(allFinite(new Float32Array([Number.NEGATIVE_INFINITY]))).toBe(false);
  });
});

describe("DisMotionEstimator.processPacked", () => {
  const width = 40;
  const height = 24;
  const rnd = seeded(99);
  const frameA = new Uint8Array(width * height * 4);
  for (let i = 0; i < frameA.length; i++) frameA[i] = i % 4 === 3 ? 255 : Math.floor(rnd() * 200);
  // Small brightness step: scene score ~0.0094, between the duplicate (0.0005) and reset (0.24) thresholds.
  const frameB = frameA.map((v, i) => (i % 4 === 0 ? Math.min(255, v + 8) : v));

  /** Deterministic grid field, independent of the frames, so process() and processPacked() see the same flow. */
  function fakeBackend(): FlowBackend {
    return {
      calc: (_c, _p, w, h) => {
        const out = new Float32Array(w * h * 2);
        for (let i = 0; i < out.length; i++) out[i] = Math.sin(i * 0.37) * 5;
        return out;
      },
    };
  }

  test("packed field equals the packed float32 field from process(), decisions identical", () => {
    const a = createMotionEstimator(width, height, { backend: fakeBackend() });
    const b = createMotionEstimator(width, height, { backend: fakeBackend() });
    const first = a.process(frameA);
    const firstPacked = b.processPacked(frameA);
    expect(first.reset).toBe(true);
    expect(firstPacked.reset).toBe(true);
    expect(firstPacked.half).toBeNull();

    const second = a.process(frameB);
    const secondPacked = b.processPacked(frameB);
    expect(second.reset).toBe(false);
    expect(second.motion).not.toBeNull();
    expect(secondPacked.reset).toBe(false);
    expect(secondPacked.confidence).toBe(1);
    expect(secondPacked.sceneScore).toBe(second.sceneScore);
    expect(secondPacked.half).toEqual(encodeMotionR16G16(second.motion!));
    a.close();
    b.close();
  });

  test("forceReset yields no motion and reset=true on both paths", () => {
    const a = createMotionEstimator(width, height, { backend: fakeBackend() });
    a.processPacked(frameA);
    const forced = a.processPacked(frameB, true);
    expect(forced.reset).toBe(true);
    expect(forced.half).toBeNull();
    a.close();
  });

  test("non-finite grid samples fall back to the exact counting path", () => {
    const backend: FlowBackend = {
      calc: (_c, _p, w, h) => {
        const out = new Float32Array(w * h * 2);
        out[0] = Number.NaN; // one poisoned sample -> some non-finite full-res vectors, confidence < 1
        return out;
      },
    };
    const a = createMotionEstimator(width, height, { backend });
    a.processPacked(frameA);
    const r = a.processPacked(frameB);
    expect(r.confidence).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.9); // a single grid sample only touches a few output pixels
    expect(r.reset).toBe(false);
    expect(r.half).not.toBeNull();
    a.close();
  });
});
