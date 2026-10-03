import { describe, expect, test } from "bun:test";
import {
  NearestTimestampWriter,
  type TimedFrame,
  chooseInterpolationPlan,
  exactNativeMultiplier,
  formatRate,
  isNativeMultiFramePlan,
  outputFrameCount,
  resolveTargetRate,
} from "../src/pipeline/framegen-plan.ts";
import { type Rational, ratCmp, ratDiv, rational } from "../src/pipeline/rational.ts";
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
    for (const engine of FRAME_GEN_ENGINES) expect(() => chooseInterpolationPlan(s30, rational(60), engine, 5), engine).not.toThrow();
    expect(() => chooseInterpolationPlan(s30, rational(60), "turbo" as never, 5)).toThrow(/Unknown frame-generation engine "turbo"\. Choose one of: auto, native, cascade\./);
    expect(() => chooseInterpolationPlan(s30, rational(60), "native", 5, { cfr: false })).toThrow(/constant-frame-rate/);
    expect(() => chooseInterpolationPlan(rational(0), rational(60), "auto", 5)).toThrow(/positive/);
  });
});

describe("isNativeMultiFramePlan", () => {
  /** The plan a 30 fps source gets on a host that reports MultiFrameCountMax 5 (native up to 6x). */
  const planTo = (targetFps: number, engine: FrameGenEngine = "auto", hagsEnabled = true) =>
    chooseInterpolationPlan(rational(30), rational(targetFps), engine, 6, { cfr: true, hagsEnabled });

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
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(4));
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(10, rational(1, 4), "DLSSG"));
    await writer.push(frame(1, rational(1, 2), "Source", 1));
    await writer.push(frame(11, rational(3, 4), "DLSSG"));
    await writer.push(frame(2, rational(1), "Source", 2));
    writer.endAt(3, rational(2));
    expect(writer.outputCount).toBe(6);
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
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2));
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(1, rational(1), "Source", 1));
    await writer.push(frame(2, rational(2), "Source", 2));
    writer.endAt(3, rational(1));
    await writer.finish();
    // t=0.5 tie -> early (0); t=1.5 tie -> late (2)
    expect(out).toEqual([0, 0, 1, 2, 2, 2]);
    expect(eq(writer.maxError, rational(1, 2))).toBe(true);
    expect(writer.generated).toBe(0);
  });

  test("missing generated frames (scene cut) are filled from real frames, length preserved", async () => {
    const out: number[] = [];
    // 2 real frames at 1 fps, target 4 fps, nothing generated -> still 8 outputs
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(4));
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(1, rational(1), "Source", 1));
    writer.endAt(2, rational(1));
    await writer.finish();
    expect(out).toHaveLength(8);
    expect(out).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  });

  test("finish with no frames throws", async () => {
    const writer = new NearestTimestampWriter(() => {}, rational(4));
    await expect(writer.finish()).rejects.toThrow(/no decodable frames/);
  });
});

// The length is fixed from the DECODED count at end of stream, so a container
// that declares the wrong number of frames — in either direction — cannot make
// the output the wrong length. Before this, a plan made from nb_frames could
// only be trimmed down, so a decode that ran LONGER than the container said was
// cut short (measured: a 240-frame 23.976-in-29.97 clip decodes to 300).
describe("NearestTimestampWriter.endAt", () => {
  const frame = (id: number, ts: Rational): TimedFrame => ({ rgba: new Uint8Array([id]), timestamp: ts, segment: 0, provenance: "Source", sourceIndex: id });

  test("fewer frames decoded than the container declared: output ends at the decoded length", async () => {
    const out: number[] = [];
    // A container claiming 3 frames at 1 fps would plan 6 outputs at 2 fps; only 2 decode.
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2));
    await writer.push(frame(0, rational(0)));
    await writer.push(frame(1, rational(1)));
    writer.endAt(2, rational(1));
    await writer.finish();
    expect(writer.outputCount).toBe(4);
    expect(out).toEqual([0, 0, 1, 1]);
  });

  test("more frames decoded than the container declared: output grows to the decoded length", async () => {
    const out: number[] = [];
    // A container claiming 2 frames at 1 fps would have capped this at 4; 3 actually decode.
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2));
    await writer.push(frame(0, rational(0)));
    await writer.push(frame(1, rational(1)));
    await writer.push(frame(2, rational(2)));
    writer.endAt(3, rational(1));
    await writer.finish();
    expect(writer.outputCount).toBe(6);
    expect(out).toHaveLength(6);
  });

  test("push() never overruns the length endAt() will set, so the cap is only ever a floor", async () => {
    const writer = new NearestTimestampWriter(() => {}, rational(60));
    // 300 frames at 30000/1001: written indices satisfy k/target <= (N-1.5)/sourceRate.
    for (let i = 0; i < 300; i++) await writer.push(frame(i, ratDiv(rational(i), rational(30000, 1001))));
    const pushedBeforeEnd = writer.nextIndex;
    writer.endAt(300, rational(30000, 1001));
    expect(writer.outputCount).toBeGreaterThanOrEqual(pushedBeforeEnd);
    expect(writer.outputCount).toBe(601);
  });

  test("finish() before endAt() fails instead of padding forever", async () => {
    const writer = new NearestTimestampWriter(() => {}, rational(2));
    await writer.push(frame(0, rational(0)));
    await expect(writer.finish()).rejects.toThrow(/before endAt/);
  });
});
