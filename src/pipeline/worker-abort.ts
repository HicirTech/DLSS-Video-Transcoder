/**
 * The abort handshake between a pipeline thread and the workers it started:
 * the pipeline side (abortWorkers) and the worker side (answerAbort).
 */

/** Sent to a pipeline worker to stop it. */
export interface AbortRequest {
  type: "abort";
}

/** A worker's answer once its child has exited and the rest of what it holds is released. */
export interface AbortedReply {
  type: "aborted";
}

/**
 * How long abortWorkers waits for the acknowledgements. Every pipeline's
 * teardown after a failure or a cancellation is bounded by this, which is what
 * JobManager's cancel grace period is built on.
 */
export const ABORT_TIMEOUT_MS = 5000;

/**
 * Send "abort" to each worker and resolve once every one has acknowledged, or
 * after `timeoutMs` (tests pass a shorter one). Never rejects. Only after the acknowledgements may the
 * caller delete a partial output: Windows refuses to unlink a file another
 * process still holds, and terminate() alone would leave the mux ffmpeg to
 * notice the closed pipe on its own and finalise the partial file first.
 * A worker that has already crashed never answers, so it must not be passed.
 */
export function abortWorkers(workers: readonly Worker[], timeoutMs = ABORT_TIMEOUT_MS): Promise<void> {
  const acknowledgements = workers.map(
    (worker) =>
      new Promise<void>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          if ((event.data as { type?: string })?.type === "aborted") {
            worker.removeEventListener("message", onMessage);
            resolve();
          }
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", () => resolve(), { once: true });
        try {
          const request: AbortRequest = { type: "abort" };
          worker.postMessage(request);
        } catch {
          resolve();
        }
      }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([Promise.all(acknowledgements).then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The worker side: kill `child` (the process holding the output file, when
 * there is one), wait for it to exit, run `release` for the rest of what the
 * worker owns, then acknowledge on `scope`. Never throws: the thread is
 * terminated next either way.
 */
export async function answerAbort(scope: Worker, child: ReturnType<typeof Bun.spawn> | null, release?: () => void): Promise<void> {
  try {
    child?.kill();
  } catch {
    // already exited
  }
  try {
    await child?.exited;
  } catch {
    // already exited
  }
  try {
    release?.();
  } catch {
    // best effort: the thread is terminated next
  }
  const reply: AbortedReply = { type: "aborted" };
  scope.postMessage(reply);
}
