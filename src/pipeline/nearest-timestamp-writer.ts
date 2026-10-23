/**
 * Frames on the exact rational timeline, and the writer that places them onto the target clock. Ported from the
 * NearestTimestampWriter in the reference project's frame_interpolation/processor.py.
 */
import { NoFramesDecodedError } from "./ffmpeg-failure.ts";
import { type Rational, ratAbs, ratAdd, ratCeil, ratCmp, ratDiv, ratMul, ratSub, rational } from "./rational.ts";

type FrameProvenance = "Source" | "DLSSG";

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

/** Count of timestamps n/targetRate in the half-open interval [0, duration). */
export function outputFrameCount(duration: Rational, targetRate: Rational): number {
  if (duration.num <= 0n || targetRate.num <= 0n) return 0;
  return Number(ratCeil(ratMul(duration, targetRate)));
}

/**
 * Places a time-ordered stream of frames onto the target clock: output frame k
 * (time k/targetRate) receives the nearest frame seen so far, exact half-way
 * ties alternating early/late so no persistent bias accumulates. Exactly
 * outputCount frames are emitted; finish() extends the final real frame over
 * the tail rather than asking a synthesiser to extrapolate past known motion.
 *
 * Why the target clock rather than "source rate x multiplier": the host
 * legitimately emits no in-between frames across scene cuts and resets, and
 * none at all when the runtime disables generation. The output length is fixed
 * from the DECODED duration (endAt), never from a container frame count or from
 * how many frames the host returned, and each instant takes the nearest
 * available frame, so the output is as long as the source whatever was
 * synthesised: audio never drifts and the video can never play too fast.
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
   * Frames to emit: unbounded until endAt() fixes it at end of stream. There is
   * deliberately no planned count. push() only writes instants before the
   * midpoint of the two frames it holds, so a cap can never make it emit MORE —
   * it can only cut the output short. A container count would: nb_frames is
   * counted in the avg_frame_rate clock, while the decoder hands this writer a
   * stream resampled to r_frame_rate, so a count planned from it covers only
   * avg_frame_rate / r_frame_rate of the decoded stream (0.8 for 23.976 fps
   * content in a 29.97 fps stream).
   */
  outputCount = Number.POSITIVE_INFINITY;

  constructor(
    private readonly sink: (rgba: Uint8Array) => Promise<void> | void,
    readonly targetRate: Rational,
  ) {}

  /**
   * Fix the output length from the frames actually decoded, in either
   * direction. `decodedFrames` is the only count measured in the same clock as
   * `sourceRate`, so decodedFrames / sourceRate is the decoded duration
   * exactly, whatever the container declared — more frames than it said, or
   * fewer. Never lowers below what has already been written.
   */
  endAt(decodedFrames: number, sourceRate: Rational): void {
    const actual = outputFrameCount(ratDiv(rational(decodedFrames), sourceRate), this.targetRate);
    this.outputCount = Math.max(actual, this.nextIndex);
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
    if (this.previous === null) throw new NoFramesDecodedError();
    // Unbounded means endAt() was skipped; padding to infinity would hang, not fail.
    if (!Number.isFinite(this.outputCount)) throw new Error("NearestTimestampWriter.finish() was called before endAt(): the output length is set from the decoded frame count at end of stream.");
    while (this.nextIndex < this.outputCount) {
      const ideal = this.ideal(this.nextIndex);
      await this.write({ ...this.previous, timestamp: ideal, provenance: "Source" }, ideal);
    }
  }
}
