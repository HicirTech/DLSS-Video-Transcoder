/** How the video and fg commands print pipeline progress. */
import type { ProgressReporter } from "../pipeline/frame-progress.ts";

/** One line per stage; the per-frame reports, which carry a frame tally, would flood the terminal and are skipped. */
export const printProgress: ProgressReporter = (fraction, message, frames) => {
  if (frames === undefined) console.log(`  ${(fraction * 100).toFixed(0)}%  ${message}`);
};
