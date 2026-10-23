/** Ctrl+C as the cancellation the video and frame generation pipelines already handle. */

/**
 * An AbortSignal the first Ctrl+C aborts, so the pipeline takes its cancellation path: it closes its stages and
 * removes the partial output. The listener runs once, so a second Ctrl+C gets the default handling and ends the
 * process at once.
 */
export function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}
