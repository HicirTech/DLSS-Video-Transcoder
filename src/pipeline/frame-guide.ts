/**
 * The per-frame guide a job's engine chain needs: the scene cuts that clear its temporal history, and Super
 * Resolution's motion vectors when the job asked for optical flow. The video job and frame generation's
 * processed frames both take it from here.
 */
import { createMotionEstimator } from "./flow.ts";
import type { ProgressReporter } from "./frame-progress.ts";
import { tryCreateNvofBackend } from "./nvof.ts";
import { SceneCutDetector } from "./scene-score.ts";

/** What the guide says about one decoded frame. */
export interface FrameGuidance {
  /** Clear temporal history: the first frame and every scene cut. */
  reset: boolean;
  /** Per-pixel motion at the frame's size, or null when the job takes none. */
  motion: Float32Array | null;
  /** A cut after the first frame, which the job counts. */
  sceneCut: boolean;
}

export interface FrameGuide {
  /** Call exactly once per frame, in decode order: both backends keep a one-frame history. */
  guide(rgba: Uint8Array, index: number): FrameGuidance;
  close(): void;
}

/**
 * The guide for `width`x`height` frames. With `flow`, the motion estimator finds the cuts as well: NVOFA on
 * the CUDA device `cudaOrdinal` when it comes up, else CPU block matching, and `progress` says which.
 */
export function createFrameGuide(width: number, height: number, options: { flow: boolean; cudaOrdinal: number; progress: ProgressReporter }): FrameGuide {
  if (!options.flow) {
    const cuts = new SceneCutDetector(width, height);
    return { guide: (rgba, index) => ({ ...cuts.guide(rgba, index), motion: null }), close: () => {} };
  }
  const nvof = tryCreateNvofBackend(width, height, options.cudaOrdinal);
  const estimator = createMotionEstimator(width, height, nvof.backend ? { backend: nvof.backend } : {});
  options.progress(0, nvof.backend ? "optical flow: NVIDIA hardware (NVOFA)" : `optical flow: CPU block matching. ${nvof.reason}`);
  return {
    guide: (rgba, index) => {
      const g = estimator.process(rgba);
      return { reset: index === 0 || g.reset, motion: g.motion, sceneCut: g.reset && index > 0 };
    },
    close: () => estimator.close(),
  };
}
