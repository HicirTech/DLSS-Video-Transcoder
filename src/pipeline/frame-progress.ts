/**
 * The progress line an encode path reports for the frames its encoder has written.
 */

/** Held below 1 so the bar does not read finished while the mux is still closing the file; the caller reports 1 once the output is complete. */
const ENCODING_PROGRESS_CEILING = 0.98;

/** `written` of `total` frames (null when the container does not say, which reads as halfway). */
export function frameProgress(written: number, total: number | null): { fraction: number; message: string } {
  return {
    fraction: total ? Math.min(ENCODING_PROGRESS_CEILING, written / total) : 0.5,
    message: `frame ${written}/${total ?? "?"}`,
  };
}
