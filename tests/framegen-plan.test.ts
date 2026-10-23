import { describe, expect, test } from "bun:test";
import {
  type InterpolationRequest,
  chooseInterpolationPlan,
  exactNativeMultiplier,
  formatRate,
  isNativeMultiFramePlan,
  resolveTargetRate,
} from "../src/pipeline/framegen-plan.ts";
import { type Rational, ratCmp, rational } from "../src/pipeline/rational.ts";
import { FRAME_GEN_ENGINES, FRAME_GEN_FPS_CHOICES, type FrameGenEngine } from "../src/server/api-types.ts";

const eq = (a: Rational, b: Rational) => ratCmp(a, b) === 0;

describe("target rates", () => {
  test("named rates are exact rationals", () => {
    expect(eq(resolveTargetRate("59.94"), rational(60000, 1001))).toBe(true);
    expect(eq(resolveTargetRate("23.976"), rational(24000, 1001))).toBe(true);
    expect(eq(resolveTargetRate("119.88"), rational(120000, 1001))).toBe(true);
  });

  test("every named choice is the rate its name says, and the list ascends", () => {
    let previous: Rational | null = null;
    for (const name of FRAME_GEN_FPS_CHOICES) {
      const rate = resolveTargetRate(name);
      expect(Number(rate.num) / Number(rate.den), name).toBeCloseTo(Number(name), 2);
      expect(formatRate(rate), name).toBe(name);
      if (previous) expect(ratCmp(previous, rate), name).toBeLessThan(0);
      previous = rate;
    }
  });

  test("a name that only exists on Object.prototype is not a named rate", () => {
    for (const name of ["toString", "constructor", "__proto__"]) expect(() => resolveTargetRate(name), name).toThrow(/Unsupported output FPS/);
  });

  test("resolveTargetRate: named beats decimal parsing, num/den and decimals accepted", () => {
    expect(eq(resolveTargetRate("23.976"), rational(24000, 1001))).toBe(true); // named, not 23976/1000
    expect(eq(resolveTargetRate("60"), rational(60))).toBe(true);
    expect(eq(resolveTargetRate("60000/1001"), rational(60000, 1001))).toBe(true);
    expect(eq(resolveTargetRate("48"), rational(48))).toBe(true);
    expect(eq(resolveTargetRate("47.5"), rational(95, 2))).toBe(true);
  });

  test("resolveTargetRate rejects garbage and non-positive rates with the choice list", () => {
    expect(() => resolveTargetRate("abc")).toThrow(/Choose one of: 23.976, 25, 29.97/);
    expect(() => resolveTargetRate("0")).toThrow(/positive/);
    expect(() => resolveTargetRate("-30")).toThrow(/positive/);
  });

  test("formatRate", () => {
    expect(formatRate(rational(60000, 1001))).toBe("59.94");
    expect(formatRate(rational(60))).toBe("60");
    expect(formatRate(rational(48))).toBe("48");
    expect(formatRate(rational(3754, 125))).toBe("30.032 (3754/125)");
  });
});

describe("exactNativeMultiplier", () => {
  const s30 = rational(30);
  const multiplier = (sourceRate: Rational, targetRate: Rational, nativeMultiplierMax: number) => exactNativeMultiplier({ sourceRate, targetRate, nativeMultiplierMax });
  test("integer ratios within the maximum", () => {
    expect(multiplier(s30, rational(60), 5)).toBe(2);
    expect(multiplier(s30, rational(120), 5)).toBe(4);
    expect(multiplier(rational(30000, 1001), rational(60000, 1001), 5)).toBe(2);
  });
  test("not above source -> 1; non-integer or above max -> null", () => {
    expect(multiplier(s30, s30, 5)).toBe(1);
    expect(multiplier(rational(60), s30, 5)).toBe(1);
    expect(multiplier(s30, rational(144), 5)).toBeNull();
    expect(multiplier(rational(24), rational(60), 5)).toBeNull(); // 2.5x
    expect(multiplier(s30, rational(180), 5)).toBeNull(); // 6 > 5
    expect(multiplier(s30, rational(180), 6)).toBe(6);
  });
});

describe("chooseInterpolationPlan", () => {
  const s30 = rational(30);
  /** A plan from a 30 fps source unless `sourceRate` says otherwise, on a runtime whose native maximum is 5x. */
  const planTo = (targetRate: Rational, request: Partial<InterpolationRequest> = {}) =>
    chooseInterpolationPlan({ sourceRate: s30, targetRate, engine: "auto", nativeMultiplierMax: 5, ...request });

  test("30 -> 60 auto with HAGS: native 2x", () => {
    const plan = planTo(rational(60), { hagsEnabled: true });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(2);
    expect(plan.generatedPerInterval).toBe(1);
    expect(plan.cascadeStages).toBe(0);
    expect(eq(plan.maximumTemporalError, rational(0))).toBe(true);
  });

  test("30 -> 120 auto: native 4x with HAGS, cascade of 2 stages without", () => {
    const withHags = planTo(rational(120), { hagsEnabled: true });
    expect(withHags.path).toBe("Native DLSSG");
    expect(withHags.nativeMultiplier).toBe(4);
    expect(withHags.generatedPerInterval).toBe(3);

    const noHags = planTo(rational(120), { hagsEnabled: false });
    expect(noHags.path).toBe("Cascade");
    expect(noHags.cascadeStages).toBe(2);
    expect(noHags.gridMultiplier).toBe(4);
    expect(noHags.nativeMultiplier).toBe(2);
    expect(noHags.generatedPerInterval).toBe(3);
    expect(eq(noHags.maximumTemporalError, rational(0))).toBe(true); // exact 4x grid
  });

  test("30 -> 60 auto without HAGS: still native 2x (only 3x and above need HAGS)", () => {
    const plan = planTo(rational(60), { hagsEnabled: false });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(2);
    expect(plan.generatedPerInterval).toBe(1);
  });

  test("engine native forces the native path even without HAGS", () => {
    const plan = planTo(rational(120), { engine: "native", hagsEnabled: false });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(4);
  });

  test("30 -> 144: cascade of 3 stages on an 8x grid, error 1/480 s", () => {
    const plan = planTo(rational(144), { hagsEnabled: true });
    expect(plan.path).toBe("Cascade");
    expect(plan.cascadeStages).toBe(3);
    expect(plan.gridMultiplier).toBe(8);
    expect(plan.generatedPerInterval).toBe(7);
    expect(eq(plan.maximumTemporalError, rational(1, 480))).toBe(true);
  });

  test("30 -> 240 past the native maximum: cascade of 3 stages whose 8x grid is exact, error 0", () => {
    const plan = planTo(rational(240), { nativeMultiplierMax: 4, hagsEnabled: true });
    expect(plan.path).toBe("Cascade");
    expect(plan.cascadeStages).toBe(3);
    expect(plan.gridMultiplier).toBe(8);
    expect(plan.generatedPerInterval).toBe(7);
    expect(eq(plan.maximumTemporalError, rational(0))).toBe(true);
  });

  test("engine native rejects a non-integer grid", () => {
    expect(() => planTo(rational(144), { engine: "native" })).toThrow(/not an exact native DLSSG grid.*native maximum 5x/);
  });

  test("29.97 -> 59.94 auto: native 2x", () => {
    const plan = planTo(rational(60000, 1001), { sourceRate: rational(30000, 1001), hagsEnabled: true });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(2);
  });

  test("24 -> 60 (2.5x): cascade of 3 stages, error 1/384 s", () => {
    const plan = planTo(rational(60), { sourceRate: rational(24), hagsEnabled: true });
    expect(plan.path).toBe("Cascade");
    expect(plan.cascadeStages).toBe(3);
    expect(eq(plan.maximumTemporalError, rational(1, 384))).toBe(true);
  });

  test("engine cascade forces a 1-stage cascade for 2x", () => {
    const plan = planTo(rational(60), { engine: "cascade", hagsEnabled: true });
    expect(plan.path).toBe("Cascade");
    expect(plan.cascadeStages).toBe(1);
    expect(plan.gridMultiplier).toBe(2);
    expect(plan.generatedPerInterval).toBe(1);
  });

  test("target at or below source: source-frame resampling", () => {
    const same = planTo(s30);
    expect(same.path).toBe("Source-frame resampling");
    expect(same.generatedPerInterval).toBe(0);
    expect(eq(same.maximumTemporalError, rational(1, 60))).toBe(true);
    expect(planTo(s30, { sourceRate: rational(60) }).path).toBe("Source-frame resampling");
  });

  test("validation", () => {
    for (const engine of FRAME_GEN_ENGINES) expect(() => planTo(rational(60), { engine }), engine).not.toThrow();
    expect(() => planTo(rational(60), { engine: "turbo" as never })).toThrow(/Unknown frame-generation engine "turbo"\. Choose one of: auto, native, cascade\./);
    expect(() => planTo(rational(60), { sourceRate: rational(0) })).toThrow(/positive/);
  });
});

describe("isNativeMultiFramePlan", () => {
  /** The plan a 30 fps source gets on a host that reports MultiFrameCountMax 5 (native up to 6x). */
  const planTo = (targetFps: number, engine: FrameGenEngine = "auto", hagsEnabled = true) =>
    chooseInterpolationPlan({ sourceRate: rational(30), targetRate: rational(targetFps), engine, nativeMultiplierMax: 6, hagsEnabled });

  test("a native session that generates two or more frames per interval is one", () => {
    expect(isNativeMultiFramePlan(planTo(90))).toBe(true); // native 3x
    expect(isNativeMultiFramePlan(planTo(120))).toBe(true); // native 4x
    expect(isNativeMultiFramePlan(planTo(180))).toBe(true); // native 6x
    expect(isNativeMultiFramePlan(planTo(120, "native", false))).toBe(true); // a forced native session runs without HAGS too
  });

  test("native 2x generates one frame per interval and is not", () => {
    expect(isNativeMultiFramePlan(planTo(60))).toBe(false);
    expect(isNativeMultiFramePlan(planTo(60, "native"))).toBe(false);
    expect(isNativeMultiFramePlan(planTo(60, "auto", false))).toBe(false); // 2x needs no HAGS
  });

  test("a cascade is not, although its stages together add several frames per source interval", () => {
    const cascades = [planTo(120, "auto", false), planTo(120, "cascade"), planTo(75)]; // 4x without HAGS, 4x forced, 2.5x
    for (const plan of cascades) {
      expect(plan.path).toBe("Cascade");
      expect(plan.generatedPerInterval).toBeGreaterThanOrEqual(2);
      expect(isNativeMultiFramePlan(plan)).toBe(false);
    }
  });

  test("a plain copy is not", () => {
    for (const plan of [planTo(30), planTo(24)]) {
      expect(plan.path).toBe("Source-frame resampling");
      expect(isNativeMultiFramePlan(plan)).toBe(false);
    }
  });
});
