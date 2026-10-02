/**
 * The DLSS-G per-interval contract: the evaluate calls an interval records and how its disable
 * flag is read. A wrong Count on the reset call or a misread flag only shows on the GPU as lost
 * or stale intervals, so both rules are pinned here.
 */
import { describe, expect, test } from "bun:test";
import { DISABLE_FLAG_BUFFER_BYTES, DISABLE_FLAG_UNWRITTEN, classifyInterval, intervalEvaluateCalls } from "../src/ngx/dlssg-interval.ts";

function flagWithFirstByte(firstByte: number): Uint8Array {
  const flag = new Uint8Array(DISABLE_FLAG_BUFFER_BYTES).fill(DISABLE_FLAG_UNWRITTEN);
  flag[0] = firstByte;
  return flag;
}

describe("intervalEvaluateCalls", () => {
  test("a normal interval evaluates indices 1..N in order, all declaring Count N, none resetting", () => {
    expect(intervalEvaluateCalls(3, false)).toEqual([
      { multiFrameCount: 3, multiFrameIndex: 1, reset: false },
      { multiFrameCount: 3, multiFrameIndex: 2, reset: false },
      { multiFrameCount: 3, multiFrameIndex: 3, reset: false },
    ]);
  });

  test("N = 1 is a single call", () => {
    expect(intervalEvaluateCalls(1, false)).toEqual([{ multiFrameCount: 1, multiFrameIndex: 1, reset: false }]);
  });

  // Declaring Count N on a reset that stops after index 1 loses the next interval (measured on 310.9.1).
  test("a reset interval is one call that declares Count 1, whatever N is", () => {
    for (const generatedCount of [1, 2, 3, 4, 5]) {
      expect(intervalEvaluateCalls(generatedCount, true)).toEqual([{ multiFrameCount: 1, multiFrameIndex: 1, reset: true }]);
    }
  });
});

describe("classifyInterval", () => {
  test("byte 0 = 0 on a normal interval is generated, whatever the rest of the buffer holds", () => {
    expect(classifyInterval(flagWithFirstByte(0), false)).toBe("generated");
  });

  test("byte 0 = 1 on a normal interval is disabled", () => {
    expect(classifyInterval(flagWithFirstByte(1), false)).toBe("disabled");
  });

  test("any other non-zero byte 0 is disabled too: the header only promises non-zero", () => {
    expect(classifyInterval(flagWithFirstByte(0x7f), false)).toBe("disabled");
  });

  test("a reset interval that wrote 1 is the honoured reset", () => {
    expect(classifyInterval(flagWithFirstByte(1), true)).toBe("reset");
  });

  test("a reset interval that wrote 0 interpolated across the reset, which is not folded into a normal result", () => {
    expect(classifyInterval(flagWithFirstByte(0), true)).toBe("resetIgnored");
  });

  test("the unwritten pre-fill still in byte 0 is a stale feature, on a normal or a reset interval", () => {
    const unwritten = new Uint8Array(DISABLE_FLAG_BUFFER_BYTES).fill(DISABLE_FLAG_UNWRITTEN);
    expect(classifyInterval(unwritten, false)).toBe("stale");
    expect(classifyInterval(unwritten, true)).toBe("stale");
  });

  test("only byte 0 decides: a written byte 0 with the pre-fill behind it is not stale", () => {
    expect(classifyInterval(Uint8Array.of(0, DISABLE_FLAG_UNWRITTEN, DISABLE_FLAG_UNWRITTEN, DISABLE_FLAG_UNWRITTEN), false)).toBe("generated");
  });

  test("an empty read-back is refused rather than taken as a result", () => {
    expect(() => classifyInterval(new Uint8Array(0), false)).toThrow(/empty/);
  });

  test("the pre-fill is neither value the runtime writes, and the buffer holds the header's 4-byte minimum", () => {
    expect(DISABLE_FLAG_UNWRITTEN).not.toBe(0);
    expect(DISABLE_FLAG_UNWRITTEN).not.toBe(1);
    expect(DISABLE_FLAG_BUFFER_BYTES).toBeGreaterThanOrEqual(4);
  });
});
