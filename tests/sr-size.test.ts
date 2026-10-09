/**
 * The SR size rule the sr command and an image job share: the output is the source size times the factor,
 * each side rounded to even (resolveTargetSize), DLSS runs in the mode nearest that ratio (qualityForSizes),
 * and srOutputProblem names what DLSS refuses. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { DLSS_SR_MAX_OUTPUT_SIDE, PerfQuality, qualityForSizes, srOutputProblem } from "../src/ngx/results.ts";
import { resolveTargetSize } from "../src/pipeline/image.ts";
import { DEFAULT_SCALE_SETTINGS } from "../src/server/api-types.ts";

function srOutput(width: number, height: number, factor: number) {
  const output = resolveTargetSize(width, height, { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor });
  return { ...output, quality: qualityForSizes(width, output.width) };
}

describe("the shared SR size rule", () => {
  test("a factor between the modes keeps its exact size and takes the nearest mode", () => {
    expect(srOutput(1000, 1000, 1.25)).toEqual({ width: 1250, height: 1250, quality: PerfQuality.MaxQuality });
    expect(srOutput(1000, 1000, 1.1)).toEqual({ width: 1100, height: 1100, quality: PerfQuality.MaxQuality });
  });

  test("a factor on a mode's ratio and one beyond the last mode", () => {
    expect(srOutput(1000, 1000, 2)).toEqual({ width: 2000, height: 2000, quality: PerfQuality.MaxPerf });
    expect(srOutput(1000, 1000, 4)).toEqual({ width: 4000, height: 4000, quality: PerfQuality.UltraPerformance });
  });

  test("factor 1 runs DLAA, an odd side rounded up to even as for every job", () => {
    expect(srOutput(800, 1169, 1)).toEqual({ width: 800, height: 1170, quality: PerfQuality.DLAA });
  });
});

describe("srOutputProblem", () => {
  const source = { width: 800, height: 1169 };

  test("an output DLSS takes is no problem", () => {
    expect(srOutputProblem(source, srOutput(800, 1169, 1))).toBeNull();
    expect(srOutputProblem(source, { width: 5600, height: DLSS_SR_MAX_OUTPUT_SIDE })).toBeNull();
  });

  test("a factor below 1 is named as a shrink DLSS SR cannot do", () => {
    expect(srOutputProblem(source, srOutput(800, 1169, 0.5))).toBe(
      "DLSS Super Resolution only enlarges: 400x584 is smaller than the 800x1169 source. Use a factor of at least 1 (1 runs DLAA at the source size).",
    );
  });

  test("a side past the limit is named with the limit", () => {
    expect(srOutputProblem(source, { width: 5600, height: DLSS_SR_MAX_OUTPUT_SIDE + 2 })).toBe(
      `DLSS Super Resolution writes at most ${DLSS_SR_MAX_OUTPUT_SIDE} pixels per side; 5600x8194 is larger. Use a smaller factor or output size.`,
    );
    expect(srOutputProblem(source, srOutput(800, 1169, 8))).toMatch(/6400x9352 is larger/);
  });
});
