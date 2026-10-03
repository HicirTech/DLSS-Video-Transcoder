/**
 * JobManager's frame counters (src/server/jobs.ts) for each kind of job, fed progress messages built
 * by the pipelines' own progress producers, the way src/pipeline/worker.ts posts them.
 */
import { describe, expect, test } from "bun:test";
import { estimatedFrameProgress, frameProgress } from "../src/pipeline/frame-progress.ts";
import { DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS, type JobRequest } from "../src/server/api-types.ts";
import { JobManager } from "../src/server/jobs.ts";
import { FakeWorker } from "./fake-worker.ts";

const IMAGE_REQUEST: JobRequest = {
  kind: "image",
  input: "W:/GPUVideoProcessor/1.png",
  engine: "nr",
  motion: "none",
  settings: { ...DEFAULT_NR_SETTINGS },
  scale: { ...DEFAULT_SCALE_SETTINGS },
};
const VIDEO_REQUEST: JobRequest = { ...IMAGE_REQUEST, kind: "video", input: "W:/GPUVideoProcessor/2.mp4" };
const FRAME_GENERATION_REQUEST: JobRequest = { ...VIDEO_REQUEST, frameGen: { targetFps: "60" } };

function start(request: JobRequest) {
  const worker = new FakeWorker();
  const jobs = new JobManager({ runtimeDir: "runtime", appDataPath: "logs", broadcast: () => {}, createWorker: () => worker.asWorker() });
  const { id } = jobs.submit(request);
  return { worker, id, status: () => jobs.get(id)! };
}

/** Runs `body` with performance.now() reading `clock.ms`, so the rate a job reports can be exact. */
function withClock<T>(clock: { ms: number }, body: () => T): T {
  const real = performance.now;
  performance.now = () => clock.ms;
  try {
    return body();
  } finally {
    performance.now = real;
  }
}

describe("a job's frame counters", () => {
  test("start at zero, with no total and no rate", () => {
    const job = start(VIDEO_REQUEST);
    expect(job.status()).toMatchObject({ framesDone: 0, framesTotal: null, fps: null });
  });

  test("a video job's progress sets the frames done and expected", () => {
    const job = start(VIDEO_REQUEST);
    job.worker.reply({ type: "progress", id: job.id, ...frameProgress(533, 3737) });
    expect(job.status()).toMatchObject({ progress: 533 / 3737, message: "frame 533/3737", framesDone: 533, framesTotal: 3737 });
    expect(job.status().fps).toBeGreaterThan(0);
  });

  test("a frame-generation job's progress counts too, though its line writes the estimate as ~3733", () => {
    const job = start(FRAME_GENERATION_REQUEST);
    job.worker.reply({ type: "progress", id: job.id, ...estimatedFrameProgress(466, 3733) });
    expect(job.status()).toMatchObject({ message: "frame 466/~3733", framesDone: 466, framesTotal: 3733 });
    expect(job.status().fps).toBeGreaterThan(0);
  });

  test("an image job counts the engine passes it runs", () => {
    const job = start(IMAGE_REQUEST);
    // image.ts builds this line inline, because running it needs the GPU; the shape is its own.
    job.worker.reply({ type: "progress", id: job.id, fraction: 0.58, message: "pass 3/5 on nr", frames: { done: 3, total: 5 } });
    expect(job.status()).toMatchObject({ framesDone: 3, framesTotal: 5 });
    expect(job.status().fps).toBeGreaterThan(0);
  });

  test("a video whose container has no frame count keeps its total unknown", () => {
    const job = start(VIDEO_REQUEST);
    job.worker.reply({ type: "progress", id: job.id, ...frameProgress(7, null) });
    expect(job.status()).toMatchObject({ framesDone: 7, framesTotal: null });
  });

  test("the rate is the frames done over the seconds since the job started", () => {
    const clock = { ms: 1000 };
    withClock(clock, () => {
      const job = start(VIDEO_REQUEST);
      clock.ms = 3000;
      job.worker.reply({ type: "progress", id: job.id, ...frameProgress(40, 100) });
      expect(job.status().fps).toBe(20);
      clock.ms = 3250;
      job.worker.reply({ type: "progress", id: job.id, ...frameProgress(41, 100) });
      expect(job.status().fps).toBe(18.2);
    });
  });

  test("a progress message without a frame count leaves the counters as they were", () => {
    const job = start(VIDEO_REQUEST);
    job.worker.reply({ type: "progress", id: job.id, fraction: 0, message: "source 1280x720 h264 30 fps, 3737 frames" });
    expect(job.status()).toMatchObject({ message: "source 1280x720 h264 30 fps, 3737 frames", framesDone: 0, framesTotal: null, fps: null });
    job.worker.reply({ type: "progress", id: job.id, ...frameProgress(10, 100) });
    job.worker.reply({ type: "progress", id: job.id, fraction: 0.97, message: "pipeline busy (s) over 51.2 s wall: decode 12.1" });
    expect(job.status()).toMatchObject({ framesDone: 10, framesTotal: 100 });
  });

  test("the message text is for display only: a line that looks like a count does not set one", () => {
    const job = start(VIDEO_REQUEST);
    job.worker.reply({ type: "progress", id: job.id, fraction: 0.4, message: "frame 40/100" });
    expect(job.status()).toMatchObject({ message: "frame 40/100", framesDone: 0, framesTotal: null, fps: null });
  });
});
