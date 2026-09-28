/**
 * Cooperative cancellation for jobs: a pipeline handed an AbortSignal stops by
 * throwing JobCancelledError, so its ordinary catch/finally path tears the run
 * down exactly as a failure would.
 */
import type { FramesWrittenRecord } from "./partial-output.ts";

export class JobCancelledError extends Error implements FramesWrittenRecord {
  override readonly name = "JobCancelledError";

  constructor(readonly framesWritten = 0) {
    super("the job was cancelled");
  }
}

/** Throw JobCancelledError once `signal` has been aborted; a no-op without a signal. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new JobCancelledError();
}

/**
 * throwIfAborted for a thread that has been doing synchronous work. A cancel
 * reaches a job thread as a message, delivered only at a task boundary — a
 * microtask is not one (measured on Bun 1.4.2) — so yield one task first.
 */
export async function throwIfAbortedAfterYield(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return;
  await Bun.sleep(0);
  throwIfAborted(signal);
}

/**
 * `work`, or JobCancelledError as soon as `signal` aborts, whichever comes
 * first: for an await that a wedged child could block forever. `work` keeps
 * running after an abort; the race has already subscribed to it, so its later
 * rejection is not an unhandled one.
 */
export function raceAbort<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new JobCancelledError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", onAbort!));
}
