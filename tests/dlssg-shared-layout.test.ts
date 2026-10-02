/**
 * The shared frame layout against byte counts worked out by hand from the frame sizes: 4 bytes per
 * pixel for the RGBA8 frame and for the R16G16_FLOAT motion field, the input first, then the generated
 * frames, with nothing between them.
 */
import { describe, expect, test } from "bun:test";
import { sharedFrameLayout, viewRange } from "../src/pipeline/dlssg-shared-layout.ts";

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

describe("sharedFrameLayout", () => {
  test("720p, one generated frame: 3,686,400 bytes of pixels, as much motion, then one frame", () => {
    expect(sharedFrameLayout({ width: 1280, height: 720, generatedCount: 1 })).toEqual({
      rgba: { offset: 0, byteLength: 3_686_400 },
      motion: { offset: 3_686_400, byteLength: 3_686_400 },
      generated: [{ offset: 7_372_800, byteLength: 3_686_400 }],
      totalBytes: 11_059_200,
    });
  });

  test("720p, five generated frames follow each other in presentation order", () => {
    const layout = sharedFrameLayout({ width: 1280, height: 720, generatedCount: 5 });
    expect(layout.generated.map((frame) => frame.offset)).toEqual([7_372_800, 11_059_200, 14_745_600, 18_432_000, 22_118_400]);
    expect(layout.generated.every((frame) => frame.byteLength === 3_686_400)).toBe(true);
    expect(layout.totalBytes).toBe(25_804_800);
  });

  test("1080p: 8,294,400 bytes per frame", () => {
    const one = sharedFrameLayout({ width: 1920, height: 1080, generatedCount: 1 });
    expect(one.motion).toEqual({ offset: 8_294_400, byteLength: 8_294_400 });
    expect(one.generated).toEqual([{ offset: 16_588_800, byteLength: 8_294_400 }]);
    expect(one.totalBytes).toBe(24_883_200);
    expect(sharedFrameLayout({ width: 1920, height: 1080, generatedCount: 5 }).totalBytes).toBe(58_060_800);
  });

  test("4K with five generated frames: 232,243,200 bytes", () => {
    expect(sharedFrameLayout({ width: 3840, height: 2160, generatedCount: 5 }).totalBytes).toBe(232_243_200);
  });

  test("a tiny odd-sized frame: 3x2 pixels are 24 bytes of each", () => {
    expect(sharedFrameLayout({ width: 3, height: 2, generatedCount: 2 })).toEqual({
      rgba: { offset: 0, byteLength: 24 },
      motion: { offset: 24, byteLength: 24 },
      generated: [{ offset: 48, byteLength: 24 }, { offset: 72, byteLength: 24 }],
      totalBytes: 96,
    });
  });

  test("a range is viewed in place, not copied", () => {
    const mapped = new Uint8Array(32);
    const view = viewRange(mapped, { offset: 8, byteLength: 4 });
    expect(view.byteLength).toBe(4);
    view.set([1, 2, 3, 4]);
    expect(mapped.subarray(6, 14)).toEqual(Uint8Array.of(0, 0, 1, 2, 3, 4, 0, 0));
  });

  test("a width, height or generated count that is not a whole number of at least 1 is refused with all three", () => {
    for (const [width, height, generatedCount] of [[0, 720, 1], [1280, 0, 1], [1280, 720, 0], [1280.5, 720, 1], [1280, 720, -1], [Number.NaN, 720, 1]] as const) {
      expect(messageOf(() => sharedFrameLayout({ width, height, generatedCount }))).toBe(
        `Shared frame memory needs a whole width, height and generatedCount of at least 1; got width ${width}, height ${height}, generatedCount ${generatedCount}`,
      );
    }
  });
});
