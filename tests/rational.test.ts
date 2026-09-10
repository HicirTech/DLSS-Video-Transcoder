/** Exact bigint rationals: the property frame-rate planning depends on is that nothing becomes a float. */
import { expect, test } from "bun:test";
import { formatRational, parseRational, ratCeil, ratCmp, ratMul, rational } from "../src/pipeline/rational.ts";

test("parseRational keeps exact rationals, integers, and decimals without float drift", () => {
  expect(parseRational("60000/1001")).toEqual({ num: 60000n, den: 1001n });
  expect(parseRational("24")).toEqual({ num: 24n, den: 1n });
  // 23.976 becomes an exact fraction 23976/1000 reduced, NOT the float 23.976.
  expect(formatRational(parseRational("23.976"))).toBe("2997/125");
  expect(formatRational(parseRational("30000/1001"))).toBe("30000/1001");
});

test("rational arithmetic reduces and compares exactly", () => {
  expect(ratMul(rational(24), rational(2))).toEqual({ num: 48n, den: 1n });
  expect(ratCmp(parseRational("60000/1001"), parseRational("60"))).toBe(-1);
  expect(ratCmp(rational(48), rational(48))).toBe(0);
  expect(ratCeil(rational(2002, 1))).toBe(2002n);
  expect(ratCeil(rational(2001, 1000))).toBe(3n);
  expect(ratCeil(rational(2000, 1000))).toBe(2n);
});
