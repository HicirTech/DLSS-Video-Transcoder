/**
 * Exact rational arithmetic in bigint, so a frame rate like 60000/1001 survives
 * every multiply and compare bit-exact. Frame-generation planning depends on
 * that: 30 -> 60 must be exactly 2x, and a timestamp must land on the instant it
 * names rather than near it.
 */

/** An exact rational number. Always reduced, always with den > 0. */
export interface Rational {
  num: bigint;
  den: bigint;
}

function bigAbs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function gcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1n;
}

/** Normalizing constructor — every Rational in this module is reduced with den > 0. */
export function rational(num: bigint | number, den: bigint | number = 1n): Rational {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) throw new Error("rational: denominator must not be zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

/**
 * Parse an ffmpeg rate string: `"60000/1001"`, `"24"` or `"23.976"`. A decimal
 * becomes an exact fraction over a power of ten — never a float, so a rate that
 * came in as text survives the round trip bit-exact.
 */
export function parseRational(text: string): Rational {
  const s = text.trim();
  if (s.includes("/")) {
    const [n, d] = s.split("/");
    return rational(BigInt(n!.trim()), BigInt(d!.trim()));
  }
  if (s.includes(".")) {
    const neg = s.startsWith("-");
    const body = neg ? s.slice(1) : s;
    const [whole, frac = ""] = body.split(".");
    const den = 10n ** BigInt(frac.length);
    const num = BigInt(whole || "0") * den + BigInt(frac || "0");
    return rational(neg ? -num : num, den);
  }
  return rational(BigInt(s), 1n);
}

/** Render a Rational back to an ffmpeg `"num/den"` rate string. */
export function formatRational(r: Rational): string {
  return `${r.num}/${r.den}`;
}

export function ratMul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function ratDiv(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den, a.den * b.num);
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function ratCmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

/** Ceiling. Negatives take the first branch because bigint `/` truncates toward zero, which already ceils them. */
export function ratCeil(r: Rational): bigint {
  if (r.num <= 0n) return r.num / r.den;
  return (r.num + r.den - 1n) / r.den;
}

export function ratAdd(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function ratSub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function ratAbs(r: Rational): Rational {
  return r.num < 0n ? { num: -r.num, den: r.den } : r;
}

/** r as a JS number (lossy; for display and float-only consumers such as ffmpeg -r). */
export function ratToNumber(r: Rational): number {
  return Number(r.num) / Number(r.den);
}
