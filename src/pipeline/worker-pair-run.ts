/**
 * The lifecycle of one decode-worker / encode-worker run, shared by the two
 * video encode orchestrators (threaded-encode.ts, async-nr-encode.ts): the run
 * settles exactly once, and an abnormal end — a failure or a cancellation —
 * first has both workers release their ffmpeg children and the output file.
 */
import { JobCancelledError } from "./cancel.ts";
import { RunFailedError } from "./partial-output.ts";
import { abortWorkers } from "./worker-abort.ts";

interface WorkerPairRunOptions<Result> {
  decodeWorker: Worker;
  encodeWorker: Worker;
  signal?: AbortSignal;
  /** Called once as the run starts finishing; see VideoJobOptions.onFinishing. */
  onFinishing?: () => void;
  /** Frees what the orchestrator itself owns, if anything. Runs once, after both workers are finished with it. */
  release?: () => void;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
}

/**
 * - running: frames flow; a cancellation or a failure stops the run.
 * - finishing: the encode worker was told to finish, so every frame is encoded
 *   and only the mux is finalising the file. A cancellation no longer stops the
 *   run — it completes and the job reports done — but a failure still does.
 * - settled: resolved, or stopping on the way to a rejection; worker messages no
 *   longer start work or report progress.
 */
type Phase = "running" | "finishing" | "settled";

export class WorkerPairRun<Result> {
  private phase: Phase = "running";
  private written = 0;
  /** Workers whose thread died: they can answer nothing, so the abort handshake skips them. */
  private readonly crashed = new Set<Worker>();

  constructor(private readonly options: WorkerPairRunOptions<Result>) {
    this.watchForCrash(options.decodeWorker, "decode");
    this.watchForCrash(options.encodeWorker, "encode");
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Whether worker messages still start work: false once the run has settled or begun stopping. */
  get active(): boolean {
    return this.phase !== "settled";
  }

  /** Whether frames still flow: false once finishing has begun or the run has settled. */
  get running(): boolean {
    return this.phase === "running";
  }

  /**
   * Frames the encode worker has written into the output (see
   * partial-output.ts). A stop reads it only once both workers have stopped, so
   * every acknowledgement they sent before that has been counted.
   */
  get framesWritten(): number {
    return this.written;
  }

  /**
   * Record one "encoded" acknowledgement. Call it for every one, in any phase:
   * after a stop the count still decides whether the partial output is this
   * run's to delete.
   */
  recordEncoded(): void {
    this.written++;
  }

  /** Tell the encode worker to finish: every frame is encoded, and from here a cancel no longer stops the run. */
  finish(): void {
    if (this.phase !== "running") return;
    this.phase = "finishing";
    this.options.onFinishing?.();
    this.options.encodeWorker.postMessage({ type: "finish" });
  }

  /** The encode worker reported the output complete. */
  succeed(result: Result): void {
    if (this.phase === "settled") return;
    this.phase = "settled";
    try {
      this.teardown();
    } catch (error) {
      this.options.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.options.resolve(result);
  }

  fail(message: string): void {
    this.stop(() => new RunFailedError(message, this.written));
  }

  private readonly onAbort = (): void => {
    if (this.phase === "running") this.stop(() => new JobCancelledError(this.written));
  };

  private watchForCrash(worker: Worker, role: string): void {
    worker.addEventListener("error", (event) => {
      this.crashed.add(worker);
      this.fail(`${role} worker crashed: ${(event as ErrorEvent).message}`);
    });
  }

  /** `errorFor` runs after the handshake, so the frame count it reads is final. */
  private stop(errorFor: () => Error): void {
    if (this.phase === "settled") return;
    this.phase = "settled";
    const alive = [this.options.decodeWorker, this.options.encodeWorker].filter((worker) => !this.crashed.has(worker));
    void abortWorkers(alive).then(() => {
      const error = errorFor();
      try {
        this.teardown();
      } catch {
        // The run has already failed or been cancelled; that is the cause to report.
      }
      this.options.reject(error);
    });
  }

  private teardown(): void {
    this.options.signal?.removeEventListener("abort", this.onAbort);
    for (const worker of [this.options.decodeWorker, this.options.encodeWorker]) {
      try {
        worker.terminate();
      } catch {
        // already gone
      }
    }
    this.options.release?.();
  }
}
