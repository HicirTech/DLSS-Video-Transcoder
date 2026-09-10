/**
 * Snapping a requested upscale factor to a DLSS quality mode.
 *
 * Two properties matter and neither is obvious from the table: the modes offered
 * must all be ones the runtime accepts, and a request to upscale must never come
 * back the same size.
 */
import { describe, expect, test } from "bun:test";
import { DLSS_RATIO, PerfQuality, qualityForFactor } from "../src/ngx/results.ts";

describe("qualityForFactor", () => {
  // Measured with tests/diag-sr-quality-modes.ts on nvngx_dlss.dll 310.7.129.0:
  // CreateFeature refuses PerfQuality 4 at 1.3x, 1.5x and 2.0x alike, while 1.3x
  // succeeds on modes 2 and 5 — the mode is unavailable, not the ratio.
  test("UltraQuality is not offered, because this runtime refuses it", () => {
    expect(DLSS_RATIO[PerfQuality.UltraQuality]).toBeUndefined();
    for (const factor of [1.05, 1.2, 1.3, 1.4, 2, 3]) {
      expect(qualityForFactor(factor)).not.toBe(PerfQuality.UltraQuality);
    }
  });

  // With UltraQuality gone, DLAA's 1.0 is the nearest ratio to anything under
  // ~1.25, so a plain nearest-match would answer "1.2x bigger" with the same
  // image — worse than the hard error this replaced.
  test("a request to upscale always lands on a mode that upscales", () => {
    for (const factor of [1.01, 1.05, 1.2, 1.3, 1.49]) {
      const ratio = DLSS_RATIO[qualityForFactor(factor)]!;
      expect(ratio).toBeGreaterThan(1);
    }
  });

  test("1.0 and below stay on DLAA, which is the no-upscale mode", () => {
    expect(qualityForFactor(1)).toBe(PerfQuality.DLAA);
    expect(qualityForFactor(0.5)).toBe(PerfQuality.DLAA);
  });

  test("an exact ratio picks its own mode", () => {
    expect(qualityForFactor(1.5)).toBe(PerfQuality.MaxQuality);
    expect(qualityForFactor(1.7241379)).toBe(PerfQuality.Balanced);
    expect(qualityForFactor(2)).toBe(PerfQuality.MaxPerf);
    expect(qualityForFactor(3)).toBe(PerfQuality.UltraPerformance);
  });

  test("beyond the top mode it stays at the top mode rather than failing", () => {
    expect(qualityForFactor(8)).toBe(PerfQuality.UltraPerformance);
  });
});
