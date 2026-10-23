/*
 * The mock job queue: jobs advance on timers and every change is published as a WsEvent. No DOM
 * dependency, so the Bun mock server (web/mock-server.ts) and the browser (`?mock=1`) share it.
 */
import type { JobRequest, JobStatus, WsEvent } from "../../../src/server/api-types";
import {
  CANCELLED_MESSAGE,
  CANCELLING_MESSAGE,
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_WARMUP_FRAMES,
  jobSteps,
  nrStackOf,
  resizesFrames,
  stepsSuffix,
  trimJobLog,
} from "../../../src/server/api-types";

export function timestamp(): string {
  return new Date().toISOString();
}

/** Where the server writes a job that names no output: next to the input, named after its steps. */
function outputPathFor(request: JobRequest): string {
  const dot = request.input.lastIndexOf(".");
  const slash = Math.max(request.input.lastIndexOf("\\"), request.input.lastIndexOf("/"));
  const stem = dot > slash ? request.input.slice(0, dot) : request.input;
  const extension = request.kind === "video" ? `.${request.encode?.container ?? DEFAULT_ENCODE_SETTINGS.container}` : ".png";
  return `${stem}.${stepsSuffix(jobSteps(request), resizesFrames(request), nrStackOf(request.neuralRendering))}${extension}`;
}

/** The frames a job counts once it runs: an image job's passes as image.ts runs them, a random length for a video. */
function framesFor(request: JobRequest): number {
  if (request.kind === "video") return 240 + Math.floor(Math.random() * 600);
  return jobSteps(request).length > 0 ? Math.max(1, (request.warmupFrames ?? DEFAULT_WARMUP_FRAMES) + 1) : 1;
}

function cloneJob(job: JobStatus): JobStatus {
  return { ...job, log: [...job.log] };
}

type Listener = (event: WsEvent) => void;
type Timer = ReturnType<typeof setTimeout>;

/** How often a running mock job advances one step. */
const TICK_MS = 400;

/** In-memory job queue that advances queued/running jobs on timers and publishes WsEvents. */
export class MockJobEngine {
  private readonly jobs = new Map<string, JobStatus>();
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Map<string, Timer>();
  /** The request of each job created here; the seed jobs have none. */
  private readonly requests = new Map<string, JobRequest>();
  private counter = 0;

  constructor(seed: JobStatus[]) {
    for (const job of seed) this.jobs.set(job.id, cloneJob(job));
    for (const job of this.jobs.values()) {
      if (job.state === "running") this.schedule(job.id, TICK_MS);
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
      // As the server does: an output the request does not name is known once the job is done.
      output: request.output ?? null,
      steps: jobSteps(request),
      state: "queued",
      cancelRequest: "none",
      progress: 0,
      message: "queued",
      framesDone: 0,
      framesTotal: null,
      fps: null,
      createdAt: timestamp(),
      startedAt: null,
      finishedAt: null,
      error: null,
      log: [`[queue] ${request.kind} job accepted (steps: ${jobSteps(request).join(", ") || "none"})`],
    };
    this.jobs.set(id, job);
    this.requests.set(id, request);
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
      job.message = CANCELLING_MESSAGE;
      this.emitJob(job);
      // One tick stands in for the pipeline's teardown.
      this.timers.set(id, setTimeout(() => {
        this.timers.delete(id);
        this.markCancelled(job);
      }, TICK_MS));
    }
    return cloneJob(job);
  }

  private markCancelled(job: JobStatus): void {
    job.state = "cancelled";
    job.finishedAt = timestamp();
    job.message = CANCELLED_MESSAGE;
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

    const request = this.requests.get(id);
    if (job.state === "queued") {
      job.state = "running";
      job.startedAt = timestamp();
      if (request) job.framesTotal = framesFor(request);
      job.message = "Creating NGX feature 18";
      this.appendLog(job, "[ngx] D3D12 device ready on adapter 0, NVSDK_NGX_D3D12_CreateFeature(18) ok");
      this.emitJob(job);
      this.schedule(id, TICK_MS);
      return;
    }
    if (job.state !== "running") return;

    const total = job.framesTotal ?? 1;
    if (job.kind === "image") {
      job.framesDone = Math.min(total, job.framesDone + 1);
      job.progress = job.framesDone / total;
      job.message = `pass ${job.framesDone}/${total}`;
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
      if (request) job.output ??= outputPathFor(request);
      job.message = "complete";
      this.appendLog(job, `[io] wrote ${job.output ?? "output"}`);
      this.emitJob(job);
      return;
    }
    this.emitJob(job);
    this.schedule(id, TICK_MS);
  }

  private appendLog(job: JobStatus, line: string): void {
    job.log.push(line);
    trimJobLog(job.log);
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
