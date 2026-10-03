/**
 * How much a frame differs from the one before it: the mean absolute luma difference over a
 * sparse grid of samples, so the cost does not grow with resolution. The motion estimator
 * (flow.ts) and the scene-cut detector both measure scene change with it.
 */

/** OpenCV RGBA2GRAY luma weights, matching guides.py. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Byte offsets of a sparse ~48x27 sample grid over an RGBA8 frame. */
export function buildSampleOffsets(width: number, height: number): Int32Array {
  const stepX = Math.max(1, Math.floor(width / 48));
  const stepY = Math.max(1, Math.floor(height / 27));
  const offsets: number[] = [];
  for (let y = stepY >> 1; y < height; y += stepY) {
    for (let x = stepX >> 1; x < width; x += stepX) offsets.push((y * width + x) * 4);
  }
  return Int32Array.from(offsets);
}

/** Sample sparse-grid luma (0..255) from an RGBA8 frame at the given offsets. */
export function sparseLuma(rgba: Uint8Array, offsets: Int32Array): Float32Array {
  const out = new Float32Array(offsets.length);
  for (let i = 0; i < offsets.length; i++) {
    const o = offsets[i]!;
    out[i] = luma(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
  }
  return out;
}

/** Mean absolute difference of two equal-length buffers (0..255 luma domain). */
export function meanAbsLumaDiff(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return a.length ? sum / a.length : 0;
}

/**
 * Scene score above this makes the motion estimator reset temporal history (guides.py:45). The score is
 * the mean absolute luma difference over 255, so 0.24 is 61.2 luma units.
 */
export const RESET_SCENE_SCORE = 0.24;
/** Scene score below this is a duplicate frame: the motion estimator emits zero motion (guides.py:44). */
export const DUPLICATE_SCENE_SCORE = 0.0005;

/**
 * Mean absolute luma difference (0-255 luma units) above which SceneCutDetector reports a cut. No source
 * or measurement is recorded for 40. A job with motion "flow" resets at RESET_SCENE_SCORE (61.2 in these
 * units); a job without it, and the GPU-resident NR path, reset at this, so the two are not interchangeable.
 */
export const SCENE_CUT_LUMA_DIFF = 40;

/**
 * Reports a scene cut when a frame's sparse-grid luma differs from the previous frame's by more
 * than SCENE_CUT_LUMA_DIFF. It keeps a one-frame history, so isCut must be called once per frame
 * and in decode order.
 */
export class SceneCutDetector {
  private previous: Float32Array | null = null;
  private readonly offsets: Int32Array;

  constructor(width: number, height: number) {
    this.offsets = buildSampleOffsets(width, height);
  }

  /** Whether `rgba` is a cut from the previous frame; the first frame is never one. */
  isCut(rgba: Uint8Array): boolean {
    const samples = sparseLuma(rgba, this.offsets);
    const cut = this.previous !== null && meanAbsLumaDiff(samples, this.previous) > SCENE_CUT_LUMA_DIFF;
    this.previous = samples;
    return cut;
  }

  /** The per-frame guide for a job without a motion estimator: the first frame and every cut reset DLSS history. */
  guide(rgba: Uint8Array, index: number): { reset: boolean; sceneCut: boolean } {
    const sceneCut = this.isCut(rgba);
    return { reset: index === 0 || sceneCut, sceneCut };
  }
}
