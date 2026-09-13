/**
 * The alpha rule around the still-image engines (enhanceStill) and the resize
 * primitives it rests on. No GPU: the engine is a stand-in that does what the
 * measured ones do to alpha — DLSS SR resamples it, feature 18 writes 255.
 */
import { describe, expect, test } from "bun:test";
import { enhanceStill } from "../src/pipeline/image.ts";
import { attachAlpha, resizePlane, resizeRgba, splitAlpha } from "../src/pipeline/resize.ts";

/** A 4x3 RGBA frame whose colour and alpha are unrelated, so a mix-up shows. */
function frame(): { rgba: Uint8Array; width: number; height: number } {
  const width = 4;
  const height = 3;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 10 * i;
    rgba[i * 4 + 1] = 200 - 5 * i;
    rgba[i * 4 + 2] = 7 * i;
    rgba[i * 4 + 3] = [0, 255, 128, 64, 255, 0, 32, 96, 160, 224, 255, 1][i]!;
  }
  return { rgba, width, height };
}

describe("splitAlpha / attachAlpha", () => {
  test("splitAlpha copies the alpha plane out and hands the engine an opaque colour frame, leaving the source alone", () => {
    const src = frame();
    const before = new Uint8Array(src.rgba);
    const { colour, alpha } = splitAlpha(src.rgba);
    expect(src.rgba).toEqual(before);
    expect(alpha).toEqual(new Uint8Array([0, 255, 128, 64, 255, 0, 32, 96, 160, 224, 255, 1]));
    for (let i = 0; i < src.width * src.height; i++) {
      expect(colour[i * 4 + 3]).toBe(255);
      expect(colour.subarray(i * 4, i * 4 + 3)).toEqual(src.rgba.subarray(i * 4, i * 4 + 3));
    }
  });

  test("attachAlpha writes only the alpha channel and rejects a plane of the wrong size", () => {
    const src = frame();
    const { colour, alpha } = splitAlpha(src.rgba);
    attachAlpha(colour, alpha);
    expect(colour).toEqual(src.rgba);
    expect(() => attachAlpha(colour, alpha.subarray(1))).toThrow(/alpha bytes do not match/);
  });
});

describe("resizePlane", () => {
  // One kernel for both: a plane resized on its own must land exactly where the
  // same channel lands inside an RGBA resize, or a re-attached alpha drifts
  // against its colour.
  test("resamples a plane exactly as the alpha channel of an RGBA resize", () => {
    const src = frame();
    const { alpha } = splitAlpha(src.rgba);
    for (const [w, h] of [[8, 6], [3, 2], [7, 5], [4, 3]] as const) {
      const viaRgba = resizeRgba(src.rgba, src.width, src.height, w, h);
      const viaPlane = resizePlane(alpha, src.width, src.height, w, h);
      expect(viaPlane.byteLength).toBe(w * h);
      for (let i = 0; i < w * h; i++) expect(viaPlane[i]).toBe(viaRgba[i * 4 + 3]);
    }
  });

  test("returns the plane itself at 1:1", () => {
    const alpha = new Uint8Array([1, 2, 3, 4]);
    expect(resizePlane(alpha, 2, 2, 2, 2)).toBe(alpha);
  });
});

describe("enhanceStill", () => {
  test("an engine that writes 255 into alpha (feature 18, measured) cannot lose the source transparency", () => {
    const src = frame();
    const out = enhanceStill(src, (colour) => {
      expect(colour.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
      const rgba = new Uint8Array(colour);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      return { rgba, width: src.width, height: src.height };
    });
    const { alpha } = splitAlpha(out.rgba);
    expect(alpha).toEqual(splitAlpha(src.rgba).alpha);
  });

  test("an upscaling engine gets alpha back at the output size, resized like the colour would be", () => {
    const src = frame();
    const out = enhanceStill(src, (colour) => ({ rgba: resizeRgba(colour, src.width, src.height, 8, 6), width: 8, height: 6 }));
    const expected = resizePlane(splitAlpha(src.rgba).alpha, src.width, src.height, 8, 6);
    expect(splitAlpha(out.rgba).alpha).toEqual(expected);
    expect(out.width).toBe(8);
  });

  test("an opaque source is untouched by the rule", () => {
    const src = frame();
    for (let i = 3; i < src.rgba.length; i += 4) src.rgba[i] = 255;
    let seen: Uint8Array | null = null;
    const out = enhanceStill(src, (colour) => {
      seen = colour;
      return { rgba: new Uint8Array(colour), width: src.width, height: src.height };
    });
    expect(seen).toEqual(src.rgba);
    expect(out.rgba).toEqual(src.rgba);
  });
});
