/**
 * What the video paths say when an ffmpeg child ends badly or decodes nothing: one wording for
 * every place that reports it, whichever thread notices.
 */

/**
 * The decode produced no frames at all. It sets no `name`: a failed job's message is the first line of
 * the error's stack, which reads "Error: No frames were decoded ..." and should not change with a refactor.
 */
export class NoFramesDecodedError extends Error {
  constructor() {
    super("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
  }
}

/** "ffmpeg <stage> failed (<exit code>): <what it printed>" for a child that exited non-zero. */
export function ffmpegFailedMessage(stage: "decode" | "encode" | "mux", exitCode: number, stderr: string): string {
  return `ffmpeg ${stage} failed (${exitCode}): ${stderr.trim()}`;
}
