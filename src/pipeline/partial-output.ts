/**
 * Who owns the file at a run's output path once the run has ended abnormally
 * (a failure or a cancellation), judged by the frames it had written there.
 */
import { existsSync, unlinkSync } from "node:fs";

/**
 * An abnormal end that knows how many frames the run had written: frames whose
 * bytes the encode side had finished writing into the output ffmpeg's stdin.
 * Zero means ffmpeg cannot have touched the file.
 */
export interface FramesWrittenRecord {
  readonly framesWritten: number;
}

/** A run that failed after writing `framesWritten` frames into its output. */
export class RunFailedError extends Error implements FramesWrittenRecord {
  override readonly name = "RunFailedError";

  constructor(
    message: string,
    readonly framesWritten: number,
  ) {
    super(message);
  }
}

/** The frames an abnormally ended run had written; 0 for an error that is not a FramesWrittenRecord. */
export function framesWrittenOf(error: unknown): number {
  const framesWritten = (error as Partial<FramesWrittenRecord> | null)?.framesWritten;
  return typeof framesWritten === "number" ? framesWritten : 0;
}

/**
 * Whether the run may delete the file at its output path. The encode ffmpeg is
 * spawned with `-y`, but its input is a pipe, so it creates or truncates the
 * destination only after input has reached its stdin (once it has probed the
 * stream) — measured on the bundled build (runtime/ffmpeg/bin 9.0.1) for the mux
 * argv and the rawvideo argv. A run that wrote no frame has therefore not
 * touched a file that was already there — and the default output name
 * (`<input>.<engine>.<container>`, or `<input>.dlssg.mp4` for frame
 * generation) is exactly what a previous good run of the same job wrote.
 */
function failedRunOwnsOutput(framesWritten: number, outputExisted: boolean): boolean {
  return framesWritten > 0 || !outputExisted;
}

/**
 * Delete the partial output an abnormally ended run owns, so a cancelled or
 * failed job never leaves a finalised-looking short file behind. Callers make
 * sure the encoder has released the file first (killed and awaited), or the
 * unlink fails on Windows and the file stays.
 */
export function removePartialOutput(output: string, framesWritten: number, outputExisted: boolean): void {
  if (!failedRunOwnsOutput(framesWritten, outputExisted)) return;
  try {
    if (existsSync(output)) unlinkSync(output);
  } catch {
    // Best effort: the file may still be held by a child that has not exited yet.
  }
}
