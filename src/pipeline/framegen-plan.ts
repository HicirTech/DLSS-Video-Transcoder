/**
 * Which path reaches a target output frame rate from the source's: the named target rates and the native, cascade
 * or resampling plan. Pure rational math, no GPU, so every rule here is unit-testable.
 *
 * Ported from the reference project's frame_interpolation/scheduler.py and models.py (FPS table).
 */
import { FRAME_GEN_ENGINES, FRAME_GEN_FPS_CHOICES, type FrameGenEngine, type FrameGenFps } from "../server/api-types.ts";
import { parseRational, type Rational, ratCmp, ratDiv, ratToNumber, rational } from "./rational.ts";

// ---------------------------------------------------------------------------
// Target rates
// ---------------------------------------------------------------------------

/**
 * The exact rate behind each named output rate (reference models.py FPS_RATES). Keyed by
 * FrameGenFps, so a name added to or dropped from FRAME_GEN_FPS_CHOICES fails to compile here.
 */
const NAMED_RATES: Record<FrameGenFps, Rational> = {
  "23.976": rational(24000, 1001),
  "25": rational(25),
  "29.97": rational(30000, 1001),
  "30": rational(30),
  "50": rational(50),
  "59.94": rational(60000, 1001),
  "60": rational(60),
  "90": rational(90),
  "119.88": rational(120000, 1001),
  "120": rational(120),
  "144": rational(144),
  "165": rational(165),
  "180": rational(180),
  "240": rational(240),
  "360": rational(360),
  "480": rational(480),
};

/**
 * The exact rate of a named choice, or undefined. Checks the choice list instead of indexing,
 * because the name is a raw user string (`--fps`, the API's frameGen.targetFps) and indexing
 * NAMED_RATES with "toString" would find Object.prototype.toString, not a rate.
 */
function namedRate(name: string): Rational | undefined {
  return (FRAME_GEN_FPS_CHOICES as readonly string[]).includes(name) ? NAMED_RATES[name as FrameGenFps] : undefined;
}

/**
 * Resolve a target rate: a named choice ("59.94"), an exact "num/den", or a
 * decimal / integer string. Throws with the list of named choices on garbage.
 */
export function resolveTargetRate(value: string): Rational {
  const key = value.trim();
  let rate = namedRate(key);
  if (!rate) {
    try {
      rate = parseRational(key);
    } catch {
      throw new Error(`Unsupported output FPS ${JSON.stringify(value)}. Choose one of: ${FRAME_GEN_FPS_CHOICES.join(", ")}, or give an exact rate such as 60000/1001.`);
    }
  }
  if (rate.num <= 0n) throw new Error("Output FPS must be positive.");
  return rate;
}

// ---------------------------------------------------------------------------
// Plan selection
// ---------------------------------------------------------------------------

/** What a plan is chosen from. */
export interface InterpolationRequest {
  sourceRate: Rational;
  targetRate: Rational;
  engine: FrameGenEngine;
  /** The highest multiplier one native session reaches on this runtime: its MultiFrameCountMax + 1. */
  nativeMultiplierMax: number;
  /**
   * Hardware-accelerated GPU scheduling state. Multi-frame (>=3x) native DLSSG
   * is refused by the runtime without HAGS, so "auto" only picks a native path
   * above 2x when this is true (2x native works either way); "native" forces it
   * regardless. Default true.
   */
  hagsEnabled?: boolean;
}

/**
 * The integer multiplier m with targetRate == m * sourceRate, when 2 <= m <=
 * nativeMultiplierMax; 1 when the target is not above the source; null when the
 * ratio is not an exact supported integer (e.g. 30 -> 144).
 */
export function exactNativeMultiplier({ sourceRate, targetRate, nativeMultiplierMax }: Pick<InterpolationRequest, "sourceRate" | "targetRate" | "nativeMultiplierMax">): number | null {
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
  /** In-between frames requested from the host per session interval (generated_count). */
  generatedPerInterval: number;
}

/** A native session that generates two or more frames per interval (3x and above); each stage of a cascade generates one, however many frames the whole cascade adds. */
export function isNativeMultiFramePlan(plan: InterpolationPlan): boolean {
  return plan.path === "Native DLSSG" && plan.generatedPerInterval >= 2;
}

/**
 * The cascade is capped at 3 stages (8x grid) because each further stage
 * doubles the evaluations per source frame while only halving the residual
 * timing error, and interpolates from frames that were themselves interpolated.
 */
const MAX_CASCADE_STAGES = 3;

/**
 * Decide how to reach targetRate from sourceRate (reference scheduler.py
 * choose_interpolation_plan, plus the HAGS gate for "auto"). The source is
 * always constant-rate here: the decoder resamples it to its nominal rate.
 */
export function chooseInterpolationPlan({ sourceRate, targetRate, engine, nativeMultiplierMax, hagsEnabled = true }: InterpolationRequest): InterpolationPlan {
  if (!FRAME_GEN_ENGINES.includes(engine)) throw new Error(`Unknown frame-generation engine ${JSON.stringify(engine)}. Choose one of: ${FRAME_GEN_ENGINES.join(", ")}.`);
  if (sourceRate.num <= 0n || targetRate.num <= 0n) throw new Error("Source and output FPS must be positive.");
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

  const native = exactNativeMultiplier({ sourceRate, targetRate, nativeMultiplierMax });
  if (engine === "native" && native === null) {
    throw new Error(
      `${formatRate(sourceRate)} -> ${formatRate(targetRate)} fps is not an exact native DLSSG grid supported by this runtime (native maximum ${nativeMultiplierMax}x). Choose auto or cascade.`,
    );
  }
  // 2x native works without HAGS; only multi-frame (m >= 3) is refused by the runtime when it is off.
  const nativeAllowed = engine === "native" || (engine === "auto" && (hagsEnabled || native === 2));
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

  const stages = ratCmp(ratio, rational(2)) === 0 ? 1 : ratCmp(ratio, rational(4)) === 0 ? 2 : MAX_CASCADE_STAGES;
  const grid = 1 << stages;
  // Every output instant falls on a grid frame only when the ratio is the grid itself: 2x, 4x or 8x.
  const exactGrid = ratCmp(ratio, rational(grid)) === 0;
  return {
    path: "Cascade",
    sourceRate,
    targetRate,
    nativeMultiplier: 2,
    gridMultiplier: grid,
    cascadeStages: stages,
    maximumTemporalError: exactGrid ? rational(0) : ratDiv(rational(1, 2 * grid), sourceRate),
    generatedPerInterval: grid - 1,
  };
}

/** "60", "59.94" (for 60000/1001) or "num/den" for display. */
export function formatRate(rate: Rational): string {
  const name = FRAME_GEN_FPS_CHOICES.find((choice) => ratCmp(NAMED_RATES[choice], rate) === 0);
  if (name !== undefined) return name;
  if (rate.den === 1n) return String(rate.num);
  const approx = Number(rate.num) / Number(rate.den);
  return `${approx.toFixed(3).replace(/\.?0+$/, "")} (${rate.num}/${rate.den})`;
}
