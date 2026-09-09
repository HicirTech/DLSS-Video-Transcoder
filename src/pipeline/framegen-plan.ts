/**
 * Frame-generation planning: which path reaches a target output frame rate
 * (native multi-frame DLSSG, or a cascade of 2x stages), how many output frames
 * a clip yields, and the nearest-timestamp resampler that places generated and
 * real frames onto the exact target clock.
 *
 * Ported from the reference project's frame_interpolation/scheduler.py,
 * models.py (FPS table) and the NearestTimestampWriter in processor.py. Pure
 * rational math, no GPU, so every rule here is unit-testable.
 *
 * Why a nearest-timestamp writer instead of "multiply the frame rate": the
 * worker legitimately emits no in-between frames across scene cuts / resets,
 * and returns none at all when the runtime disables generation. Deciding the
 * output frame count from the source DURATION (not from how many frames came
 * back) and filling each output instant with the nearest available frame keeps
 * the output the same length as the source no matter what was synthesised, so
 * audio never drifts and the video can never play too fast.
 */
import { parseRational, type Rational, ratAbs, ratAdd, ratCeil, ratCmp, ratDiv, ratMul, ratSub, rational } from "./nut.ts";

// ---------------------------------------------------------------------------
// Target rates
// ---------------------------------------------------------------------------

/** The named output rates the UI/CLI offer, ascending, as exact rationals (reference models.py FPS_RATES). */
const FPS_TABLE: ReadonlyArray<readonly [string, Rational]> = [
  ["23.976", rational(24000, 1001)],
  ["25", rational(25)],
  ["29.97", rational(30000, 1001)],
  ["30", rational(30)],
  ["50", rational(50)],
  ["59.94", rational(60000, 1001)],
  ["60", rational(60)],
  ["90", rational(90)],
  ["119.88", rational(120000, 1001)],
  ["120", rational(120)],
  ["144", rational(144)],
  ["165", rational(165)],
  ["180", rational(180)],
  ["240", rational(240)],
  ["360", rational(360)],
  ["480", rational(480)],
];
/** Ascending choice list. An explicit array: object key order would list the integer names ("25", "30") before "23.976". */
export const FPS_CHOICES: readonly string[] = FPS_TABLE.map(([name]) => name);
export const FPS_RATES: Readonly<Record<string, Rational>> = Object.fromEntries(FPS_TABLE);

export type FrameGenEngine = "auto" | "native" | "cascade";
export const FRAMEGEN_ENGINES: readonly FrameGenEngine[] = ["auto", "native", "cascade"];

/**
 * Resolve a target rate: a named choice ("59.94"), an exact "num/den", or a
 * decimal / integer string. Throws with the list of named choices on garbage.
 */
export function resolveTargetRate(value: string | Rational): Rational {
  if (typeof value !== "string") {
    if (value.num <= 0n || value.den <= 0n) throw new Error("Output FPS must be positive.");
    return value;
  }
  const key = value.trim();
  let rate = FPS_RATES[key];
  if (!rate) {
    try {
      rate = parseRational(key);
    } catch {
      throw new Error(`Unsupported output FPS ${JSON.stringify(value)}. Choose one of: ${FPS_CHOICES.join(", ")}, or give an exact rate such as 60000/1001.`);
    }
  }
  if (rate.num <= 0n) throw new Error("Output FPS must be positive.");
  return rate;
}

// ---------------------------------------------------------------------------
// Plan selection
// ---------------------------------------------------------------------------

/** Count of timestamps n/targetRate in the half-open interval [0, duration). */
export function outputFrameCount(duration: Rational, targetRate: Rational): number {
  if (duration.num <= 0n || targetRate.num <= 0n) return 0;
  return Number(ratCeil(ratMul(duration, targetRate)));
}

/**
 * The integer multiplier m with targetRate == m * sourceRate, when 2 <= m <=
 * nativeMultiplierMax; 1 when the target is not above the source; null when the
 * ratio is not an exact supported integer (e.g. 30 -> 144).
 */
export function exactNativeMultiplier(sourceRate: Rational, targetRate: Rational, nativeMultiplierMax: number): number | null {
  if (ratCmp(targetRate, sourceRate) <= 0) return 1;
  const ratio = ratDiv(targetRate, sourceRate);
  if (ratio.den !== 1n) return null;
  const multiplier = Number(ratio.num);
  return multiplier >= 2 && multiplier <= nativeMultiplierMax ? multiplier : null;
}

export type InterpolationPath = "Source-frame resampling" | "Native DLSSG" | "Cascade";

export interface InterpolationPlan {
  path: InterpolationPath;
  sourceRate: Rational;
  targetRate: Rational;
  /** Frames per source interval each DLSSG session produces (real + generated): m for native, 2 for every cascade stage. */
  nativeMultiplier: number;
  /** Fine timeline density: nativeMultiplier for native, 1 << cascadeStages for a cascade. */
  gridMultiplier: number;
  cascadeStages: number;
  /** Worst-case distance between an output instant and the fine-grid frame chosen for it. */
  maximumTemporalError: Rational;
  /** In-between frames requested from the worker per session interval (generated_count). */
  generatedPerInterval: number;
}

export interface PlanOptions {
  /** Source is constant-frame-rate (native DLSSG needs a deterministic CFR timeline). Default true. */
  cfr?: boolean;
  /**
   * Hardware-accelerated GPU scheduling state. Multi-frame (>=3x) native DLSSG
   * is refused by the runtime without HAGS, so "auto" only picks a native path
   * above 2x when this is true (2x native works either way); "native" forces it
   * regardless. Default true.
   */
  hagsEnabled?: boolean;
}

/**
 * Decide how to reach targetRate from sourceRate (reference scheduler.py
 * choose_interpolation_plan, plus the HAGS gate for "auto").
 *
 * - target <= source: no synthesis, plain resampling.
 * - exact integer ratio within the runtime's native maximum (and HAGS on, or
 *   engine "native"): one native session generating m-1 frames per interval.
 * - otherwise: a cascade of 2x stages — 1 stage for 2x, 2 for 4x, else 3
 *   (grid 8) — and the nearest-timestamp writer maps the target clock onto the
 *   resulting 2^stages grid.
 */
export function chooseInterpolationPlan(
  sourceRate: Rational,
  targetRate: Rational,
  engine: FrameGenEngine,
  nativeMultiplierMax: number,
  options: PlanOptions = {},
): InterpolationPlan {
  if (!FRAMEGEN_ENGINES.includes(engine)) throw new Error(`Unknown frame-generation engine ${JSON.stringify(engine)}. Choose auto, native or cascade.`);
  if (sourceRate.num <= 0n || targetRate.num <= 0n) throw new Error("Source and output FPS must be positive.");
  const cfr = options.cfr ?? true;
  const hags = options.hagsEnabled ?? true;
  const ratio = ratDiv(targetRate, sourceRate);

  if (ratCmp(targetRate, sourceRate) <= 0) {
    return {
      path: "Source-frame resampling",
      sourceRate,
      targetRate,
      nativeMultiplier: 1,
      gridMultiplier: 1,
      cascadeStages: 0,
      maximumTemporalError: ratDiv(rational(1, 2), sourceRate),
      generatedPerInterval: 0,
    };
  }

  const nativeExact = exactNativeMultiplier(sourceRate, targetRate, nativeMultiplierMax);
  if (engine === "native") {
    if (!cfr) throw new Error("Native DLSSG requires constant-frame-rate input. Choose auto or cascade so the file can be placed on a deterministic CFR timeline.");
    if (nativeExact === null) {
      throw new Error(
        `${formatRate(sourceRate)} -> ${formatRate(targetRate)} fps is not an exact native DLSSG grid supported by this runtime (native maximum ${nativeMultiplierMax}x). Choose auto or cascade.`,
      );
    }
  }
  const native = cfr ? nativeExact : null;
  // 2x native works without HAGS; only multi-frame (m >= 3) is refused by the runtime when it is off.
  const nativeAllowed = engine === "native" || (engine === "auto" && (hags || native === 2));
  if (native !== null && nativeAllowed) {
    return {
      path: "Native DLSSG",
      sourceRate,
      targetRate,
      nativeMultiplier: native,
      gridMultiplier: native,
      cascadeStages: 0,
      maximumTemporalError: rational(0),
      generatedPerInterval: native - 1,
    };
  }

  const stages = ratCmp(ratio, rational(2)) === 0 ? 1 : ratCmp(ratio, rational(4)) === 0 ? 2 : 3;
  const grid = 1 << stages;
  const exactDyadic = cfr && (ratCmp(ratio, rational(2)) === 0 || ratCmp(ratio, rational(4)) === 0);
  return {
    path: "Cascade",
    sourceRate,
    targetRate,
    nativeMultiplier: 2,
    gridMultiplier: grid,
    cascadeStages: stages,
    maximumTemporalError: exactDyadic ? rational(0) : ratDiv(rational(1, 2 * grid), sourceRate),
    generatedPerInterval: grid - 1,
  };
}

/** "60", "59.94" (for 60000/1001) or "num/den" for display. */
export function formatRate(rate: Rational): string {
  for (const [name, value] of FPS_TABLE) if (ratCmp(value, rate) === 0) return name;
  if (rate.den === 1n) return String(rate.num);
  const approx = Number(rate.num) / Number(rate.den);
  return `${approx.toFixed(3).replace(/\.?0+$/, "")} (${rate.num}/${rate.den})`;
}

// ---------------------------------------------------------------------------
// Timed frames and the nearest-timestamp writer
// ---------------------------------------------------------------------------

export type FrameProvenance = "Source" | "DLSSG";

/** A frame on the exact rational timeline: real (Source) or synthesised (DLSSG). */
export interface TimedFrame {
  rgba: Uint8Array;
  timestamp: Rational;
  /** Increments at timestamp discontinuities and scene cuts; frames never interpolate across segments. */
  segment: number;
  provenance: FrameProvenance;
  /** Decode index for real frames, null for generated ones. */
  sourceIndex: number | null;
}

/**
 * Places a time-ordered stream of frames onto the target clock: output frame k
 * (time k/targetRate) receives the nearest frame seen so far, exact half-way
 * ties alternating early/late so no persistent bias accumulates. Exactly
 * outputCount frames are emitted; finish() extends the final real frame over
 * the tail rather than asking a synthesiser to extrapolate past known motion.
 */
export class NearestTimestampWriter {
  nextIndex = 0;
  copied = 0;
  generated = 0;
  maxError: Rational = rational(0);
  readonly selectedRealIds = new Set<number>();
  private previous: TimedFrame | null = null;
  private tieLate = false;

  /**
   * Frames to emit. Planned from the container's frame count up front; the
   * caller may lower it at end of stream to what was actually decoded (a
   * container that declares more frames than it decodes would otherwise end
   * in a short freeze). Never raise it after pushes began.
   */
  outputCount: number;

  constructor(
    private readonly sink: (rgba: Uint8Array) => Promise<void> | void,
    readonly targetRate: Rational,
    outputCount: number,
  ) {
    this.outputCount = outputCount;
  }

  private ideal(index: number): Rational {
    return ratDiv(rational(index), this.targetRate);
  }

  private async write(frame: TimedFrame, ideal: Rational): Promise<void> {
    await this.sink(frame.rgba);
    const error = ratAbs(ratSub(frame.timestamp, ideal));
    if (ratCmp(error, this.maxError) > 0) this.maxError = error;
    if (frame.provenance === "DLSSG") this.generated++;
    else {
      this.copied++;
      if (frame.sourceIndex !== null) this.selectedRealIds.add(frame.sourceIndex);
    }
    this.nextIndex++;
  }

  async push(current: TimedFrame): Promise<void> {
    if (this.previous === null) {
      this.previous = current;
      return;
    }
    const midpoint = ratDiv(ratAdd(this.previous.timestamp, current.timestamp), rational(2));
    while (this.nextIndex < this.outputCount) {
      const ideal = this.ideal(this.nextIndex);
      const order = ratCmp(ideal, midpoint);
      if (order < 0) await this.write(this.previous, ideal);
      else if (order === 0) {
        const selected = this.tieLate ? current : this.previous;
        this.tieLate = !this.tieLate;
        await this.write(selected, ideal);
      } else break;
    }
    this.previous = current;
  }

  async finish(): Promise<void> {
    if (this.previous === null) throw new Error("The input video contains no decodable frames.");
    while (this.nextIndex < this.outputCount) {
      const ideal = this.ideal(this.nextIndex);
      await this.write({ ...this.previous, timestamp: ideal, provenance: "Source" }, ideal);
    }
  }
}
