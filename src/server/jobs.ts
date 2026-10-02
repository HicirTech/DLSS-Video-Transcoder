/**
 * In-memory job queue. One job runs at a time (one GPU), each in its own
 * worker so the HTTP server never blocks on native calls.
 */
import type { JobRequest, JobStatus, WsEvent } from "./api-types.ts";
import { HOST_PROCESS_NAME } from "../pipeline/dlssg-host-launch.ts";
import type { CancelMessage, RunMessage, WorkerMessage } from "../pipeline/worker.ts";
import { ABORT_TIMEOUT_MS } from "../pipeline/worker-abort.ts";

const LOG_LIMIT = 400;
const MAX_JOBS = 200;
/**
 * How long a running job gets to stop on its own after a cancel before its
 * thread is terminated regardless. A pipeline's teardown is bounded by
 * ABORT_TIMEOUT_MS; the 3 s on top is a chosen margin for releasing the GPU
 * session after it, not a measured one. Measured on 2.mp4 (RTX 5090,
 * 2026-09-28), every path reached "cancelled" 26–343 ms after the request, so
 * this only fires for a thread wedged in a synchronous call.
 */
const CANCEL_GRACE_MS = ABORT_TIMEOUT_MS + 3000;

/**
 * How long a job cancelled too late — already finishing its output — gets to
 * complete before its thread is terminated anyway, so a finalise that has
 * stalled (a network drive, say) cannot hold the one-job queue until a
 * restart. Finalising measured 1.6–3.0 s for the 107–158 MB outputs of 2.mp4,
 * and mp4 +faststart about 0.6 s per GB on local NVMe (RTX 5090 machine,
 * 2026-09-28); 60 s is a chosen margin above that for large outputs on slow
 * storage, not a measured bound.
 */
const FINISHING_GRACE_MS = 60_000;

const CANCELLED_MESSAGE = "cancelled by user";
const CANCELLING_MESSAGE = "cancelling";
const TOO_LATE_MESSAGE = "finishing: the cancel arrived after the last frame, so the job completes and keeps its output";

export interface JobManagerOptions {
  runtimeDir: string;
  appDataPath: string;
  broadcast: (event: WsEvent) => void;
  /** Where a job runs; the default is a Worker thread on src/pipeline/worker.ts. Tests hand in a stand-in. */
  createWorker?: () => Worker;
  /** Overrides CANCEL_GRACE_MS (tests). */
  cancelGraceMs?: number;
  /** Overrides FINISHING_GRACE_MS (tests). */
  finishingGraceMs?: number;
}

interface Entry {
  status: JobStatus;
  request: JobRequest;
  worker: Worker | null;
  startedAtMs: number;
  lastFrameAtMs: number;
  /** Set while a cancelled running job is expected to answer; fires terminate() if it does not in time. */
  cancelTimer: ReturnType<typeof setTimeout> | null;
  /** The job posted "finishing": a cancel can no longer stop it. */
  finishing: boolean;
}

export class JobManager {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private active: string | null = null;

  constructor(private readonly options: JobManagerOptions) {}

  list(): JobStatus[] {
    return this.order.map((id) => this.entries.get(id)!.status).reverse();
  }

  get(id: string): JobStatus | null {
    return this.entries.get(id)?.status ?? null;
  }

  submit(request: JobRequest): JobStatus {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const status: JobStatus = {
      id,
      kind: request.kind,
      input: request.input,
      output: request.output ?? null,
      engine: request.engine,
      state: "queued",
      cancelRequest: "none",
      progress: 0,
      message: "queued",
      framesDone: 0,
      framesTotal: null,
      fps: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      log: [],
    };
    this.entries.set(id, { status, request, worker: null, startedAtMs: 0, lastFrameAtMs: 0, cancelTimer: null, finishing: false });
    this.order.push(id);
    this.evict();
    this.publish(status);
    this.pump();
    return status;
  }

  /** Keep history (and memory) bounded: drop the oldest finished jobs beyond MAX_JOBS. */
  private evict(): void {
    while (this.order.length > MAX_JOBS) {
      const idx = this.order.findIndex((id) => {
        const s = this.entries.get(id)!.status.state;
        return s === "done" || s === "failed" || s === "cancelled";
      });
      if (idx < 0) break; // nothing evictable (only queued/running remain)
      const [removed] = this.order.splice(idx, 1);
      this.entries.delete(removed!);
    }
  }

  /**
   * A queued job is cancelled outright. A running one is asked to stop and
   * stays "running" with cancelRequest "pending" until its worker answers:
   * cancelled — or done / failed when it had already started finishing,
   * which it reports first ("too-late"), or when a failure got there first. The job's own teardown is what frees the
   * GPU session and removes the partial output; terminate() skips both, so it
   * is only the fallback for a worker that has not answered within
   * CANCEL_GRACE_MS, or within FINISHING_GRACE_MS once it was too late.
   */
  cancel(id: string): JobStatus | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const status = entry.status;
    if (status.state === "queued") {
      this.finish(entry, "cancelled", CANCELLED_MESSAGE);
    } else if (status.state === "running" && status.cancelRequest === "none") {
      if (entry.finishing) {
        this.refuseCancel(entry);
        return status;
      }
      const cancelMessage: CancelMessage = { type: "cancel" };
      entry.worker?.postMessage(cancelMessage);
      status.cancelRequest = "pending";
      status.message = CANCELLING_MESSAGE;
      this.terminateUnlessAnswered(entry, this.options.cancelGraceMs ?? CANCEL_GRACE_MS);
      this.publish(status);
    }
    return status;
  }

  /** The job was already finishing, so the cancel cannot stop it; say so and give it FINISHING_GRACE_MS to complete. */
  private refuseCancel(entry: Entry): void {
    entry.status.cancelRequest = "too-late";
    entry.status.message = TOO_LATE_MESSAGE;
    this.terminateUnlessAnswered(entry, this.options.finishingGraceMs ?? FINISHING_GRACE_MS);
    this.publish(entry.status);
  }

  /** (Re)arm the fallback that terminates a cancelled job whose worker has not answered within `graceMs`; finish() disarms it. */
  private terminateUnlessAnswered(entry: Entry, graceMs: number): void {
    if (entry.cancelTimer !== null) clearTimeout(entry.cancelTimer);
    entry.cancelTimer = setTimeout(() => {
      entry.cancelTimer = null;
      const output = entry.status.output ?? "the default output path next to the input";
      // Only video jobs have children; an image job writes its file only once it is finishing.
      const { frameGen } = entry.request;
      const children = frameGen ? `ffmpeg.exe and ${HOST_PROCESS_NAME}` : "ffmpeg.exe";
      const leftovers =
        entry.request.kind === "video"
          ? `its ${children} may still be running and holding a partial output at ${output}, and `
          : entry.finishing
            ? `a partial output may remain at ${output}, and `
            : "";
      this.finish(
        entry,
        "cancelled",
        `${CANCELLED_MESSAGE}, but the job did not end within ${graceMs / 1000} s and its thread was terminated: ${leftovers}the GPU memory it held stays allocated until the server is restarted.`,
      );
    }, graceMs);
  }

  private pump(): void {
    if (this.active) return;
    const next = this.order.map((id) => this.entries.get(id)!).find((e) => e.status.state === "queued");
    if (!next) return;
    this.active = next.status.id;
    next.status.state = "running";
    next.status.startedAt = new Date().toISOString();
    next.status.message = "starting";
    next.startedAtMs = performance.now();
    this.publish(next.status);

    const worker = this.options.createWorker ? this.options.createWorker() : new Worker(new URL("../pipeline/worker.ts", import.meta.url).href);
    next.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.onWorkerMessage(next, event.data);
    worker.onerror = (event: ErrorEvent) => {
      this.finish(next, "failed", `The job stopped unexpectedly: ${event.message}`);
    };
    const run: RunMessage = {
      type: "run",
      id: next.status.id,
      request: next.request,
      runtimeDir: this.options.runtimeDir,
      appDataPath: this.options.appDataPath,
    };
    worker.postMessage(run);
  }

  private onWorkerMessage(entry: Entry, message: WorkerMessage): void {
    const status = entry.status;
    switch (message.type) {
      case "progress": {
        status.progress = Math.max(0, Math.min(1, message.fraction));
        // Once cancelled, the message says what became of the cancel; later progress must not hide it.
        if (status.cancelRequest === "none") status.message = message.message;
        const frames = /frame (\d+)\/(\d+|\?)/.exec(message.message);
        if (frames) {
          status.framesDone = Number(frames[1]);
          status.framesTotal = frames[2] === "?" ? null : Number(frames[2]);
          const elapsed = (performance.now() - entry.startedAtMs) / 1000;
          status.fps = elapsed > 0 ? Math.round((status.framesDone / elapsed) * 10) / 10 : null;
        }
        this.publish(status);
        break;
      }
      case "log":
        status.log.push(message.line);
        if (status.log.length > LOG_LIMIT) status.log.splice(0, status.log.length - LOG_LIMIT);
        this.options.broadcast({ type: "log", jobId: status.id, line: message.line });
        break;
      case "done":
        status.output = message.output;
        status.log.push(`done: ${JSON.stringify(message.detail)}`);
        this.finish(entry, "done", "complete");
        break;
      case "failed":
        status.log.push(message.error);
        this.finish(entry, "failed", message.error.split("\n")[0] ?? "failed");
        break;
      case "finishing":
        entry.finishing = true;
        if (status.cancelRequest === "pending") this.refuseCancel(entry);
        break;
      case "cancelled":
        this.finish(entry, "cancelled", CANCELLED_MESSAGE);
        break;
    }
  }

  private finish(entry: Entry, state: JobStatus["state"], message: string): void {
    const status = entry.status;
    status.state = state;
    status.message = message;
    status.finishedAt = new Date().toISOString();
    if (state === "done") status.progress = 1;
    if (state === "failed") status.error = message;
    if (entry.cancelTimer !== null) {
      clearTimeout(entry.cancelTimer);
      entry.cancelTimer = null;
    }
    // By now the worker has either answered (its teardown is done) or is being
    // given up on; terminate() only reclaims the thread.
    entry.worker?.terminate();
    entry.worker = null;
    if (this.active === status.id) this.active = null;
    this.publish(status);
    queueMicrotask(() => this.pump());
  }

  private publish(status: JobStatus): void {
    this.options.broadcast({ type: "job", job: structuredClone(status) });
  }
}
