/**
 * What a job reports while it works through frames: the fraction for the bar, the line for the
 * log and the frame count JobStatus carries. Each producer builds all three together, so the line a
 * person reads and the numbers the server shows cannot disagree.
 */

/** Frames a job has finished out of the frames it expects; `total` is null when the source does not say. */
export interface FrameTally {
  done: number;
  total: number | null;
}

/**
 * How a pipeline reports progress. `frames` is set on the lines that count frames, and only on
 * those: the job worker keeps them out of the job log, where one line per frame would be noise.
 */
export type ProgressReporter = (fraction: number, message: string, frames?: FrameTally) => void;

/** The arguments of one `ProgressReporter` call that counts frames. */
interface FrameReport {
  fraction: number;
  message: string;
  frames: FrameTally;
}

/** Held below 1 so the bar does not read finished while the mux is still closing the file; the caller reports 1 once the output is complete. */
const ENCODING_PROGRESS_CEILING = 0.98;

/** `written` of `total` frames (null when the container does not say, which reads as halfway). */
export function frameProgress(written: number, total: number | null): FrameReport {
  return {
    fraction: total ? Math.min(ENCODING_PROGRESS_CEILING, written / total) : 0.5,
    message: `frame ${written}/${total ?? "?"}`,
    frames: { done: written, total },
  };
}

/** Held below the 0.97 and 0.98 reports that follow once the stream has ended (framegen.ts), so the bar never runs backwards. */
const FRAME_GENERATION_PROGRESS_CEILING = 0.96;

/**
 * Frame generation: `processed` source frames of `expected`, the count the constant-rate decode is
 * expected to yield. That is an estimate, which the "~" in the line says: the exact length is known
 * only when the stream ends, so `processed` can end past `expected` (2.mp4 decodes 3734 frames
 * against an estimate of 3733).
 */
export function estimatedFrameProgress(processed: number, expected: number): FrameReport {
  return {
    fraction: Math.min(FRAME_GENERATION_PROGRESS_CEILING, processed / expected),
    message: `frame ${processed}/~${expected}`,
    frames: { done: processed, total: expected },
  };
}
