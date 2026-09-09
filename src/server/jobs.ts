/**
 * In-memory job queue. One job runs at a time (one GPU), each in its own
 * worker so the HTTP server never blocks on native calls.
 */
import type { JobRequest, JobStatus, WsEvent } from "./api-types.ts";
import type { RunMessage, WorkerMessage } from "../pipeline/worker.ts";

const LOG_LIMIT = 400;
const MAX_JOBS = 200;

export interface JobManagerOptions {
  runtimeDir: string;
  appDataPath: string;
  broadcast: (event: WsEvent) => void;
}

interface Entry {
  status: JobStatus;
  request: JobRequest;
  worker: Worker | null;
  startedAtMs: number;
  lastFrameAtMs: number;
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
    this.entries.set(id, { status, request, worker: null, startedAtMs: 0, lastFrameAtMs: 0 });
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

  cancel(id: string): JobStatus | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.status.state === "queued" || entry.status.state === "running") {
      entry.worker?.terminate();
      entry.worker = null;
      this.finish(entry, "cancelled", "cancelled by user");
    }
    return entry.status;
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

    const worker = new Worker(new URL("../pipeline/worker.ts", import.meta.url).href);
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
        status.message = message.message;
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
    }
  }

  private finish(entry: Entry, state: JobStatus["state"], message: string): void {
    const status = entry.status;
    status.state = state;
    status.message = message;
    status.finishedAt = new Date().toISOString();
    if (state === "done") status.progress = 1;
    if (state === "failed") status.error = message;
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
