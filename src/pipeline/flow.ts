/**
 * Optical-flow motion vectors for the DLSS / DLSSG / DLSSNR motion-vector
 * contract, ported from the reference DIS generator (dref guides.py).
 *
 * Output unit and convention, which `FrameInput.motion` (engine.ts) already
 * expects so the engine only packs to R16G16_FLOAT with MV.Scale = 1.0: a
 * backward per-pixel field in RENDER-RESOLUTION PIXELS, interleaved (x, y),
 * origin top-left, +x right, +y down, no y flip. DIS sign convention:
 * `calc(current, previous)` maps current -> previous, `MV[p] = prevPos - curPos`.
 *
 * OpenCV is unavailable in Bun, so the producer is a pure-TS block matcher on a
 * downscaled gray grid (guides.py:24-55). Everything here is GPU-free, so it is
 * unit-testable without a GPU.
 */
import { createBlockMatchBackend, type FlowBackend } from "./block-match.ts";
import { flowGridSize, smallGray } from "./flow-grid.ts";
import { allFinite, packFlowResizedR16G16, resizeFlowBilinear } from "./flow-resize.ts";
import { encodeMotionR16G16 } from "./half-float.ts";
import { buildSampleOffsets, DUPLICATE_SCENE_SCORE, meanAbsLumaDiff, RESET_SCENE_SCORE, sparseLuma } from "./scene-score.ts";

// -- Reference reset threshold (guides.py DLSSGGuideGenerator) ---

/** Finite-vector fraction below this forces a reset (guides.py:63). */
export const RESET_CONFIDENCE = 0.98;

// -- Estimator -----------------------------------------------------------------

export interface MotionResult {
  /**
   * Interleaved (x, y) motion in RENDER-RESOLUTION pixels, length width*height*2.
   * Null whenever there is no usable motion — first frame, scene cut, duplicate
   * or low confidence — which the engine treats as zero motion plus reset.
   */
  motion: Float32Array | null;
  /** First frame, scene cut, or confidence below RESET_CONFIDENCE: drop temporal history. */
  reset: boolean;
  /** Normalized [0,1] scene score (mean abs luma diff / 255). */
  sceneScore: number;
  /** Near-duplicate frame (sceneScore below DUPLICATE_SCENE_SCORE); not a reset. */
  duplicate: boolean;
  /** Fraction of finite motion vectors in [0,1]; 1.0 on a duplicate. */
  confidence: number;
}

/** MotionResult with the field already packed as R16G16_FLOAT, the form the DLSSG host consumes. */
export interface PackedMotionResult {
  /** Interleaved (x, y) halves in render pixels, length width*height*2; null as in MotionResult.motion. */
  half: Uint16Array | null;
  reset: boolean;
  sceneScore: number;
  duplicate: boolean;
  confidence: number;
}

/**
 * The analysis half of processPacked(): scene decisions plus the grid-resolution
 * flow, so the expensive upsample + pack can run on another thread. At most one
 * of `small` / `half` is ever set — `small` on the fast path, for the caller to
 * finish with packFlowResizedR16G16; `half` when a non-finite grid sample forced
 * the exact path to build the full field here.
 */
export interface AnalyzedMotion {
  small: Float32Array | null;
  half: Uint16Array | null;
  reset: boolean;
  sceneScore: number;
  duplicate: boolean;
  confidence: number;
}

export interface MotionEstimator {
  /**
   * Feed the next RGBA8 frame. `forceReset` marks a discontinuity only the
   * caller can see (timestamp gap, new segment) and makes the frame a scene cut
   * whatever its score.
   */
  process(rgba: Uint8Array, forceReset?: boolean): MotionResult;
  /**
   * process() with the motion already packed as halves, skipping the
   * full-resolution float32 field frame generation would only convert anyway.
   */
  processPacked(rgba: Uint8Array, forceReset?: boolean): PackedMotionResult;
  /** processPacked() split in two: decisions + grid flow here, packing left to the caller (see AnalyzedMotion). */
  analyzePacked(rgba: Uint8Array, forceReset?: boolean): AnalyzedMotion;
  close(): void;
}

export interface MotionEstimatorOptions {
  /**
   * A ready-made backend such as the NVOFA one (default: pure-TS block matching).
   * It lives behind bun:ffi, which this GPU-free module cannot pull in, so the
   * caller builds it.
   */
  backend?: FlowBackend;
}

/**
 * What scene analysis decided about one frame. A `settled` frame already has its
 * final verdict and confidence — first frame, scene cut or duplicate, none of
 * which produce a flow field. Otherwise the grid flow comes back and the caller
 * settles reset and confidence once it knows how much of the upsampled field is
 * finite.
 */
type Analysis =
  | { settled: true; reset: boolean; sceneScore: number; duplicate: boolean; confidence: number }
  | { settled: false; small: Float32Array; sceneScore: number };

class DisMotionEstimator implements MotionEstimator {
  private readonly flowW: number;
  private readonly flowH: number;
  private readonly offsets: Int32Array;
  private prevGray: Float32Array | null = null;
  private prevSamples: Float32Array | null = null;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly backend: FlowBackend,
  ) {
    const { flowW, flowH } = flowGridSize(width, height);
    this.flowW = flowW;
    this.flowH = flowH;
    this.offsets = buildSampleOffsets(width, height);
  }

  /** Scene analysis shared by every entry point: advances the history and returns the grid flow when there is one to upsample. */
  private analyze(rgba: Uint8Array, forceReset: boolean): Analysis {
    if (rgba.length < this.width * this.height * 4) {
      throw new Error(`flow: frame is ${rgba.length} bytes, expected ${this.width * this.height * 4}`);
    }
    const samples = sparseLuma(rgba, this.offsets);
    const gray = smallGray(rgba, this.width, this.height, this.flowW, this.flowH);

    // Nothing to compare the first frame against, so it is a forced reset.
    if (!this.prevGray || !this.prevSamples) {
      this.prevGray = gray;
      this.prevSamples = samples;
      return { settled: true, reset: true, sceneScore: 1, duplicate: false, confidence: 0 };
    }

    const sceneScore = meanAbsLumaDiff(samples, this.prevSamples) / 255;
    const duplicate = sceneScore < DUPLICATE_SCENE_SCORE;
    // A caller-known discontinuity resets exactly like a detected cut (guides.py: force_reset or score above threshold).
    const sceneReset = forceReset || sceneScore > RESET_SCENE_SCORE;
    if (duplicate || sceneReset) {
      this.prevGray = gray;
      this.prevSamples = samples;
      // A duplicate holds the temporal history (confidence 1); a cut discards it.
      return { settled: true, reset: sceneReset, sceneScore, duplicate, confidence: duplicate ? 1 : 0 };
    }

    // Grid pixels, current -> previous; the caller scales to render pixels.
    const small = this.backend.calc(gray, this.prevGray, this.flowW, this.flowH);
    this.prevGray = gray;
    this.prevSamples = samples;
    return { settled: false, small, sceneScore };
  }

  /**
   * Exact path: full-resolution render-pixel field plus the finite fraction,
   * with non-finite vectors zeroed (guides.py:52-63).
   */
  private toFull(small: Float32Array): { full: Float32Array; confidence: number } {
    const full = resizeFlowBilinear(small, this.flowW, this.flowH, this.width, this.height);
    // resizeFlowBilinear leaves magnitudes in grid pixels.
    const kx = this.width / this.flowW;
    const ky = this.height / this.flowH;
    let finite = 0;
    for (let i = 0; i < this.width * this.height; i++) {
      const xi = i * 2;
      const yi = xi + 1;
      const x = full[xi]! * kx;
      const y = full[yi]! * ky;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        full[xi] = x;
        full[yi] = y;
        finite++;
      } else {
        full[xi] = 0;
        full[yi] = 0;
      }
    }
    return { full, confidence: finite / (this.width * this.height) };
  }

  process(rgba: Uint8Array, forceReset = false): MotionResult {
    const a = this.analyze(rgba, forceReset);
    if (a.settled) return { motion: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    const { full, confidence } = this.toFull(a.small);
    const reset = confidence < RESET_CONFIDENCE;
    return { motion: reset ? null : full, reset, sceneScore: a.sceneScore, duplicate: false, confidence };
  }

  analyzePacked(rgba: Uint8Array, forceReset = false): AnalyzedMotion {
    const a = this.analyze(rgba, forceReset);
    if (a.settled) return { small: null, half: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    if (allFinite(a.small)) return { small: a.small, half: null, reset: false, sceneScore: a.sceneScore, duplicate: false, confidence: 1 };
    const { full, confidence } = this.toFull(a.small);
    const reset = confidence < RESET_CONFIDENCE;
    return { small: null, half: reset ? null : encodeMotionR16G16(full), reset, sceneScore: a.sceneScore, duplicate: false, confidence };
  }

  processPacked(rgba: Uint8Array, forceReset = false): PackedMotionResult {
    const a = this.analyze(rgba, forceReset);
    if (a.settled) return { half: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    // A finite grid — always so for block matching and NVOFA — interpolates to a
    // finite field, so confidence is exactly 1 and one fused pass can replace
    // resize + scale + count + pack.
    if (allFinite(a.small)) {
      return { half: packFlowResizedR16G16(a.small, this.flowW, this.flowH, this.width, this.height), reset: false, sceneScore: a.sceneScore, duplicate: false, confidence: 1 };
    }
    const { full, confidence } = this.toFull(a.small);
    const reset = confidence < RESET_CONFIDENCE;
    return { half: reset ? null : encodeMotionR16G16(full), reset, sceneScore: a.sceneScore, duplicate: false, confidence };
  }

  close(): void {
    this.prevGray = null;
    this.prevSamples = null;
    this.backend.close?.();
  }
}

/**
 * Motion estimator turning consecutive RGBA8 frames of the given render size
 * into the DLSS motion-vector field. It keeps the previous frame's gray grid and
 * samples, so one estimator serves one stream and must not be shared.
 */
export function createMotionEstimator(width: number, height: number, opts: MotionEstimatorOptions = {}): MotionEstimator {
  if (width <= 0 || height <= 0) throw new Error(`flow: invalid size ${width}x${height}`);
  // A ready-made backend (e.g. the NVOFA GPU one) is used as given; its close()
  // then runs through the estimator's close(), not the caller's.
  const backend = opts.backend ?? createBlockMatchBackend();
  return new DisMotionEstimator(width, height, backend);
}
