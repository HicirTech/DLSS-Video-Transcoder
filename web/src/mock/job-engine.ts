/*
 * The mock job queue: jobs advance on timers and every change is published as a WsEvent. No DOM
 * dependency, so the Bun mock server (web/mock-server.ts) and the browser (`?mock=1`) share it.
 */
import type { JobRequest, JobStatus, WsEvent } from "../../../src/server/api-types";
import { CANCELLED_MESSAGE, JOB_LOG_LIMIT } from "../../../src/server/api-types";

export function timestamp(): string {
  return new Date().toISOString();
}

function outputPathFor(request: JobRequest): string {
  const dot = request.input.lastIndexOf(".");
  const slash = Math.max(request.input.lastIndexOf("\\"), request.input.lastIndexOf("/"));
  const hasExtension = dot > slash;
  const stem = hasExtension ? request.input.slice(0, dot) : request.input;
  const extension =
    request.kind === "video" ? `.${request.encode?.container ?? "mp4"}` : hasExtension ? request.input.slice(dot) : ".png";
  return `${stem}-nr${extension}`;
}

function cloneJob(job: JobStatus): JobStatus {
  return { ...job, log: [...job.log] };
}

type Listener = (event: WsEvent) => void;
type Timer = ReturnType<typeof setTimeout>;

/** In-memory job queue that advances queued/running jobs on timers and publishes WsEvents. */
export class MockJobEngine {
  private readonly jobs = new Map<string, JobStatus>();
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Map<string, Timer>();
  private readonly tickMs: number;
  private counter = 0;

  constructor(seed: JobStatus[] = [], tickMs = 400) {
    this.tickMs = tickMs;
    for (const job of seed) this.jobs.set(job.id, cloneJob(job));
    for (const job of this.jobs.values()) {
      if (job.state === "running") this.schedule(job.id, tickMs);
      else if (job.state === "queued") this.schedule(job.id, 2500);
    }
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map(cloneJob);
  }

  get(id: string): JobStatus | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  create(request: JobRequest): JobStatus {
    this.counter += 1;
    const id = `job-${Date.now().toString(36)}${this.counter.toString(36)}`;
    const job: JobStatus = {
      id,
      kind: request.kind,
      input: request.input,
      output: request.output && request.output.trim() !== "" ? request.output : outputPathFor(request),
      engine: request.engine,
      state: "queued",
      cancelRequest: "none",
      progress: 0,
      message: "Queued",
      framesDone: 0,
      framesTotal: request.kind === "image" ? 1 : 240 + Math.floor(Math.random() * 600),
      fps: null,
      createdAt: timestamp(),
      startedAt: null,
      finishedAt: null,
      error: null,
      log: [
        `[queue] ${request.kind} job accepted (engine=${request.engine}, motion=${request.motion}, scale=${request.scale.mode})`,
      ],
    };
    this.jobs.set(id, job);
    this.emitJob(job);
    this.schedule(id, 700);
    return cloneJob(job);
  }

  /** As the server does: a queued job is cancelled at once, a running one is "cancelling" until its pipeline has stopped. */
  cancel(id: string): JobStatus | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.state === "queued") {
      this.clearTimer(id);
      this.markCancelled(job);
    } else if (job.state === "running" && job.cancelRequest === "none") {
      this.clearTimer(id);
      job.cancelRequest = "pending";
      job.message = "cancelling";
      this.emitJob(job);
      // One tick stands in for the pipeline's teardown.
      this.timers.set(id, setTimeout(() => {
        this.timers.delete(id);
        this.markCancelled(job);
      }, this.tickMs));
    }
    return cloneJob(job);
  }

  private markCancelled(job: JobStatus): void {
    job.state = "cancelled";
    job.finishedAt = timestamp();
    job.message = "Cancelled by user";
    this.appendLog(job, `[job] ${CANCELLED_MESSAGE}`);
    this.emitJob(job);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  private schedule(id: string, delay: number): void {
    this.clearTimer(id);
    this.timers.set(
      id,
      setTimeout(() => this.tick(id), delay),
    );
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private tick(id: string): void {
    this.timers.delete(id);
    const job = this.jobs.get(id);
    if (!job) return;

    if (job.state === "queued") {
      job.state = "running";
      job.startedAt = timestamp();
      job.message = "Creating NGX feature 18";
      this.appendLog(job, "[ngx] D3D12 device ready on adapter 0, NVSDK_NGX_D3D12_CreateFeature(18) ok");
      this.emitJob(job);
      this.schedule(id, this.tickMs);
      return;
    }
    if (job.state !== "running") return;

    const total = job.framesTotal ?? 1;
    if (job.kind === "image") {
      job.progress = Math.min(1, job.progress + 0.2);
      const warmup = Math.min(4, Math.round(job.progress * 5));
      job.message = `Warm-up evaluation ${warmup}/4`;
    } else {
      const step = Math.max(1, Math.round(total / 60 + Math.random() * 4));
      job.framesDone = Math.min(total, job.framesDone + step);
      job.progress = job.framesDone / total;
      job.fps = Math.round((21 + Math.random() * 5) * 10) / 10;
      job.message = `Frame ${job.framesDone}/${total}`;
      if (job.framesDone % 120 < step) this.emitLog(job, `[nr] frame ${job.framesDone}: evaluate ok (${job.fps} fps)`);
    }

    if (job.progress >= 1) {
      job.framesDone = total;
      job.progress = 1;
      job.state = "done";
      job.finishedAt = timestamp();
      job.message = "Done";
      this.appendLog(job, `[io] wrote ${job.output ?? "output"}`);
      this.emitJob(job);
      return;
    }
    this.emitJob(job);
    this.schedule(id, this.tickMs);
  }

  private appendLog(job: JobStatus, line: string): void {
    job.log.push(line);
    if (job.log.length > JOB_LOG_LIMIT) job.log.splice(0, job.log.length - JOB_LOG_LIMIT);
  }

  private emitLog(job: JobStatus, line: string): void {
    this.appendLog(job, line);
    this.emit({ type: "log", jobId: job.id, line });
  }

  private emitJob(job: JobStatus): void {
    this.emit({ type: "job", job: cloneJob(job) });
  }

  private emit(event: WsEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
