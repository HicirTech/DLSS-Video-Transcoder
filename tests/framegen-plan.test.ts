import { describe, expect, test } from "bun:test";
import {
  FPS_CHOICES,
  FPS_RATES,
  FRAMEGEN_ENGINES,
  NearestTimestampWriter,
  type TimedFrame,
  chooseInterpolationPlan,
  exactNativeMultiplier,
  formatRate,
  outputFrameCount,
  resolveTargetRate,
} from "../src/pipeline/framegen-plan.ts";
import { type Rational, ratCmp, rational } from "../src/pipeline/nut.ts";
import { FRAME_GEN_ENGINES, FRAME_GEN_FPS_CHOICES } from "../src/server/api-types.ts";

const eq = (a: Rational, b: Rational) => ratCmp(a, b) === 0;

describe("shared API contract", () => {
  test("the UI's named choices are exactly the pipeline's, in the same order", () => {
    expect([...FPS_CHOICES]).toEqual([...FRAME_GEN_FPS_CHOICES]);
    expect([...FRAMEGEN_ENGINES]).toEqual([...FRAME_GEN_ENGINES]);
  });
});

describe("target rates", () => {
  test("named rates are exact rationals", () => {
    expect(eq(FPS_RATES["59.94"]!, rational(60000, 1001))).toBe(true);
    expect(eq(FPS_RATES["23.976"]!, rational(24000, 1001))).toBe(true);
    expect(eq(FPS_RATES["119.88"]!, rational(120000, 1001))).toBe(true);
  });

  test("resolveTargetRate: named beats decimal parsing, num/den and decimals accepted", () => {
    expect(eq(resolveTargetRate("23.976"), rational(24000, 1001))).toBe(true); // named, not 23976/1000
    expect(eq(resolveTargetRate("60"), rational(60))).toBe(true);
    expect(eq(resolveTargetRate("60000/1001"), rational(60000, 1001))).toBe(true);
    expect(eq(resolveTargetRate("48"), rational(48))).toBe(true);
    expect(eq(resolveTargetRate("47.5"), rational(95, 2))).toBe(true);
    expect(eq(resolveTargetRate(rational(90)), rational(90))).toBe(true);
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

describe("outputFrameCount", () => {
  test("ceil(duration * target)", () => {
    // 121 frames at 30 fps -> 4.0333 s -> 484 frames at 120 fps
    expect(outputFrameCount(rational(121, 30), rational(120))).toBe(484);
    // 29.97 -> 59.94 is exactly 2x: 1000 frames -> 2000
    const src = rational(30000, 1001);
    expect(outputFrameCount(rational(1000n * src.den, src.num), rational(60000, 1001))).toBe(2000);
    // 30 -> 144: 10 s -> 1440
    expect(outputFrameCount(rational(10), rational(144))).toBe(1440);
    expect(outputFrameCount(rational(0), rational(60))).toBe(0);
  });
});

describe("exactNativeMultiplier", () => {
  const s30 = rational(30);
  test("integer ratios within the maximum", () => {
    expect(exactNativeMultiplier(s30, rational(60), 5)).toBe(2);
    expect(exactNativeMultiplier(s30, rational(120), 5)).toBe(4);
    expect(exactNativeMultiplier(rational(30000, 1001), rational(60000, 1001), 5)).toBe(2);
  });
  test("not above source -> 1; non-integer or above max -> null", () => {
    expect(exactNativeMultiplier(s30, s30, 5)).toBe(1);
    expect(exactNativeMultiplier(rational(60), s30, 5)).toBe(1);
    expect(exactNativeMultiplier(s30, rational(144), 5)).toBeNull();
    expect(exactNativeMultiplier(rational(24), rational(60), 5)).toBeNull(); // 2.5x
    expect(exactNativeMultiplier(s30, rational(180), 5)).toBeNull(); // 6 > 5
    expect(exactNativeMultiplier(s30, rational(180), 6)).toBe(6);
  });
});

describe("chooseInterpolationPlan", () => {
  const s30 = rational(30);

  test("30 -> 60 auto with HAGS: native 2x", () => {
    const plan = chooseInterpolationPlan(s30, rational(60), "auto", 5, { hagsEnabled: true });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(2);
    expect(plan.generatedPerInterval).toBe(1);
    expect(plan.cascadeStages).toBe(0);
    expect(eq(plan.maximumTemporalError, rational(0))).toBe(true);
  });

  test("30 -> 120 auto: native 4x with HAGS, cascade of 2 stages without", () => {
    const withHags = chooseInterpolationPlan(s30, rational(120), "auto", 5, { hagsEnabled: true });
    expect(withHags.path).toBe("Native DLSSG");
    expect(withHags.nativeMultiplier).toBe(4);
    expect(withHags.generatedPerInterval).toBe(3);

    const noHags = chooseInterpolationPlan(s30, rational(120), "auto", 5, { hagsEnabled: false });
    expect(noHags.path).toBe("Cascade");
    expect(noHags.cascadeStages).toBe(2);
    expect(noHags.gridMultiplier).toBe(4);
    expect(noHags.nativeMultiplier).toBe(2);
    expect(noHags.generatedPerInterval).toBe(3);
    expect(eq(noHags.maximumTemporalError, rational(0))).toBe(true); // exact dyadic
  });

  test("30 -> 60 auto without HAGS: still native 2x (only 3x and above need HAGS)", () => {
    const plan = chooseInterpolationPlan(s30, rational(60), "auto", 5, { hagsEnabled: false });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(2);
    expect(plan.generatedPerInterval).toBe(1);
  });

  test("engine native forces the native path even without HAGS", () => {
    const plan = chooseInterpolationPlan(s30, rational(120), "native", 5, { hagsEnabled: false });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(4);
  });

  test("30 -> 144: cascade of 3 stages on an 8x grid, error 1/480 s", () => {
    const plan = chooseInterpolationPlan(s30, rational(144), "auto", 5, { hagsEnabled: true });
    expect(plan.path).toBe("Cascade");
    expect(plan.cascadeStages).toBe(3);
    expect(plan.gridMultiplier).toBe(8);
    expect(plan.generatedPerInterval).toBe(7);
    expect(eq(plan.maximumTemporalError, rational(1, 480))).toBe(true);
  });

  test("engine native rejects a non-integer grid", () => {
    expect(() => chooseInterpolationPlan(s30, rational(144), "native", 5)).toThrow(/not an exact native DLSSG grid.*native maximum 5x/);
  });

  test("29.97 -> 59.94 auto: native 2x", () => {
    const plan = chooseInterpolationPlan(rational(30000, 1001), rational(60000, 1001), "auto", 5, { hagsEnabled: true });
    expect(plan.path).toBe("Native DLSSG");
    expect(plan.nativeMultiplier).toBe(2);
  });

  test("24 -> 60 (2.5x): cascade of 3 stages, error 1/384 s", () => {
    const plan = chooseInterpolationPlan(rational(24), rational(60), "auto", 5, { hagsEnabled: true });
    expect(plan.path).toBe("Cascade");
    expect(plan.cascadeStages).toBe(3);
    expect(eq(plan.maximumTemporalError, rational(1, 384))).toBe(true);
  });

  test("engine cascade forces a 1-stage cascade for 2x", () => {
    const plan = chooseInterpolationPlan(s30, rational(60), "cascade", 5, { hagsEnabled: true });
    expect(plan.path).toBe("Cascade");
    expect(plan.cascadeStages).toBe(1);
    expect(plan.gridMultiplier).toBe(2);
    expect(plan.generatedPerInterval).toBe(1);
  });

  test("target at or below source: source-frame resampling", () => {
    const same = chooseInterpolationPlan(s30, s30, "auto", 5);
    expect(same.path).toBe("Source-frame resampling");
    expect(same.generatedPerInterval).toBe(0);
    expect(eq(same.maximumTemporalError, rational(1, 60))).toBe(true);
    expect(chooseInterpolationPlan(rational(60), s30, "auto", 5).path).toBe("Source-frame resampling");
  });

  test("validation", () => {
    expect(() => chooseInterpolationPlan(s30, rational(60), "turbo" as never, 5)).toThrow(/Unknown frame-generation engine/);
    expect(() => chooseInterpolationPlan(s30, rational(60), "native", 5, { cfr: false })).toThrow(/constant-frame-rate/);
    expect(() => chooseInterpolationPlan(rational(0), rational(60), "auto", 5)).toThrow(/positive/);
  });
});

describe("NearestTimestampWriter", () => {
  const mark = (id: number) => new Uint8Array([id]);
  const frame = (id: number, ts: Rational, provenance: "Source" | "DLSSG", sourceIndex: number | null = null, segment = 0): TimedFrame => ({
    rgba: mark(id),
    timestamp: ts,
    segment,
    provenance,
    sourceIndex,
  });

  test("real + generated stream at 2 fps resampled to 4 fps", async () => {
    const out: number[] = [];
    // 3 real frames at 2 fps (duration 3/2 s) -> 6 output frames at 4 fps
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(4), outputFrameCount(rational(3, 2), rational(4)));
    expect(writer.outputCount).toBe(6);
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(10, rational(1, 4), "DLSSG"));
    await writer.push(frame(1, rational(1, 2), "Source", 1));
    await writer.push(frame(11, rational(3, 4), "DLSSG"));
    await writer.push(frame(2, rational(1), "Source", 2));
    await writer.finish();
    expect(out).toEqual([0, 10, 1, 11, 2, 2]);
    expect(writer.generated).toBe(2);
    expect(writer.copied).toBe(4);
    expect([...writer.selectedRealIds].sort()).toEqual([0, 1, 2]);
    expect(eq(writer.maxError, rational(0))).toBe(true);
  });

  test("exact half-way ties alternate early/late", async () => {
    const out: number[] = [];
    // 3 real frames at 1 fps, no generated frames, target 2 fps -> 6 outputs
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2), 6);
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(1, rational(1), "Source", 1));
    await writer.push(frame(2, rational(2), "Source", 2));
    await writer.finish();
    // t=0.5 tie -> early (0); t=1.5 tie -> late (2)
    expect(out).toEqual([0, 0, 1, 2, 2, 2]);
    expect(eq(writer.maxError, rational(1, 2))).toBe(true);
    expect(writer.generated).toBe(0);
  });

  test("missing generated frames (scene cut) are filled from real frames, length preserved", async () => {
    const out: number[] = [];
    // 2 real frames at 1 fps, target 4 fps, nothing generated -> still 8 outputs
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(4), 8);
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(1, rational(1), "Source", 1));
    await writer.finish();
    expect(out).toHaveLength(8);
    expect(out).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  });

  test("finish with no frames throws", async () => {
    const writer = new NearestTimestampWriter(() => {}, rational(4), 4);
    await expect(writer.finish()).rejects.toThrow(/no decodable frames/);
  });
});

describe("NearestTimestampWriter.outputCount trimmed at end of stream", () => {
  test("lowering outputCount before finish() ends the output at the decoded duration", async () => {
    const out: number[] = [];
    // Planned for 3 source frames at 1 fps (target 2 fps -> 6 frames) but only 2 decode: trim to ceil(2 * 2) = 4.
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2), outputFrameCount(rational(3), rational(2)));
    expect(writer.outputCount).toBe(6);
    const frame = (id: number, ts: Rational): TimedFrame => ({ rgba: new Uint8Array([id]), timestamp: ts, segment: 0, provenance: "Source", sourceIndex: id });
    await writer.push(frame(0, rational(0)));
    await writer.push(frame(1, rational(1)));
    writer.outputCount = Math.max(outputFrameCount(rational(2), rational(2)), writer.nextIndex);
    await writer.finish();
    expect(writer.outputCount).toBe(4);
    expect(out).toEqual([0, 0, 1, 1]);
  });
});
