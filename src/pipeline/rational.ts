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
  let numerator = BigInt(num);
  let denominator = BigInt(den);
  if (denominator === 0n) throw new Error("rational: denominator must not be zero");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = gcd(numerator, denominator);
  return { num: numerator / divisor, den: denominator / divisor };
}

/**
 * Parse an ffmpeg rate string: `"60000/1001"`, `"24"` or `"23.976"`. A decimal
 * becomes an exact fraction over a power of ten — never a float, so a rate that
 * came in as text survives the round trip bit-exact.
 */
export function parseRational(text: string): Rational {
  const trimmed = text.trim();
  if (trimmed.includes("/")) {
    const [numeratorText, denominatorText] = trimmed.split("/");
    return rational(BigInt(numeratorText!.trim()), BigInt(denominatorText!.trim()));
  }
  if (trimmed.includes(".")) {
    const neg = trimmed.startsWith("-");
    const body = neg ? trimmed.slice(1) : trimmed;
    const [whole, frac = ""] = body.split(".");
    const den = 10n ** BigInt(frac.length);
    const num = BigInt(whole || "0") * den + BigInt(frac || "0");
    return rational(neg ? -num : num, den);
  }
  return rational(BigInt(trimmed), 1n);
}

/**
 * A frame rate as ffprobe or ffmpeg prints it, or null when the text names no usable rate: empty,
 * "N/A", "0/0", a zero denominator ("1/0", which ffprobe prints for a stream whose duration is
 * zero) or a rate that is not above zero. ffmpeg rejects the unusable ones as argv, so every
 * caller that passes a rate on has to treat null as "no rate".
 */
export function tryParseRate(text: string | undefined): Rational | null {
  if (!text) return null;
  let rate: Rational;
  try {
    rate = parseRational(text);
  } catch {
    return null;
  }
  return rate.num > 0n ? rate : null;
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

/** r as a JS number (lossy; for estimates, tolerances and display only, never for anything passed to ffmpeg). */
export function ratToNumber(r: Rational): number {
  return Number(r.num) / Number(r.den);
}
