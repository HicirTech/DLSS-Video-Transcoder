/**
 * JobManager's cancel state machine (src/server/jobs.ts), driven by a stand-in
 * worker that answers the way src/pipeline/worker.ts does.
 */
import { describe, expect, test } from "bun:test";
import { JobManager, type JobManagerOptions } from "../src/server/jobs.ts";
import type { JobRequest } from "../src/server/api-types.ts";
import { DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS } from "../src/server/api-types.ts";
import { FakeWorker } from "./fake-worker.ts";

function request(): JobRequest {
  return { kind: "image", input: "W:/GPUVideoProcessor/1.png", engine: "nr", motion: "none", settings: { ...DEFAULT_NR_SETTINGS }, scale: { ...DEFAULT_SCALE_SETTINGS } };
}

function manager(worker: FakeWorker, graces: Pick<JobManagerOptions, "cancelGraceMs" | "finishingGraceMs"> = {}): JobManager {
  return new JobManager({ runtimeDir: "runtime", appDataPath: "logs", broadcast: () => {}, createWorker: () => worker.asWorker(), ...graces });
}

describe("JobManager.cancel", () => {
  test("a running job is asked to stop and stays running with the cancel pending until the worker answers cancelled", () => {
    const worker = new FakeWorker();
    const jobs = manager(worker);
    const { id } = jobs.submit(request());
    expect(jobs.get(id)!.state).toBe("running");
    expect(jobs.get(id)!.cancelRequest).toBe("none");
    expect(worker.sent[0]).toMatchObject({ type: "run", id });

    const afterCancel = jobs.cancel(id)!;
    expect(afterCancel.state).toBe("running");
    expect(afterCancel.cancelRequest).toBe("pending");
    expect(afterCancel.message).toBe("cancelling");
    expect(worker.sent[1]).toEqual({ type: "cancel" });
    expect(worker.terminated).toBe(false);

    // A second click while cancelling asks nothing new.
    jobs.cancel(id);
    expect(worker.sent.length).toBe(2);

    worker.reply({ type: "cancelled", id });
    expect(jobs.get(id)!.state).toBe("cancelled");
    expect(jobs.get(id)!.message).toBe("cancelled by user");
    expect(worker.terminated).toBe(true);
  });

  test("progress that arrives while the cancel is pending updates the counters but keeps 'cancelling' visible", () => {
    const worker = new FakeWorker();
    const jobs = manager(worker, { cancelGraceMs: 1000 });
    const { id } = jobs.submit(request());
    jobs.cancel(id);
    worker.reply({ type: "progress", id, fraction: 0.4, message: "frame 40/100" });
    const status = jobs.get(id)!;
    expect(status.message).toBe("cancelling");
    expect(status.progress).toBe(0.4);
    expect(status.framesDone).toBe(40);
    worker.reply({ type: "cancelled", id });
    expect(jobs.get(id)!.state).toBe("cancelled");
  });

  test("a job that reports finishing after the cancel was sent is waited on, not terminated, and reported too late", async () => {
    const worker = new FakeWorker();
    const jobs = manager(worker, { cancelGraceMs: 20 });
    const { id } = jobs.submit(request());
    jobs.cancel(id);
    worker.reply({ type: "finishing", id });
    expect(jobs.get(id)!.cancelRequest).toBe("too-late");
    expect(jobs.get(id)!.message).toContain("completes");
    await Bun.sleep(40);
    expect(worker.terminated).toBe(false);
    expect(jobs.get(id)!.state).toBe("running");
    worker.reply({ type: "done", id, output: "out.mp4", detail: {} });
    expect(jobs.get(id)!.state).toBe("done");
  });

  test("a job cancelled too late that then stalls is terminated after the finishing grace, and the message says what is left", async () => {
    const worker = new FakeWorker();
    const jobs = manager(worker, { cancelGraceMs: 1000, finishingGraceMs: 20 });
    const { id } = jobs.submit(request());
    worker.reply({ type: "finishing", id });
    jobs.cancel(id);
    await Bun.sleep(40);
    const status = jobs.get(id)!;
    expect(status.state).toBe("cancelled");
    expect(status.message).toContain("did not end within 0.02 s");
    expect(status.message).toContain("partial output");
    expect(worker.terminated).toBe(true);
  });

  test("a cancel for a job that is already finishing is refused at once and never sent", () => {
    const worker = new FakeWorker();
    const jobs = manager(worker);
    const { id } = jobs.submit(request());
    worker.reply({ type: "finishing", id });
    expect(jobs.cancel(id)!.cancelRequest).toBe("too-late");
    expect(worker.sentOfType("cancel")).toHaveLength(0);
  });

  test("a job that finishes before it could stop is reported done, not cancelled, and stays done", async () => {
    const worker = new FakeWorker();
    const jobs = manager(worker, { cancelGraceMs: 20 });
    const { id } = jobs.submit(request());
    jobs.cancel(id);
    worker.reply({ type: "done", id, output: "out.png", detail: {} });
    expect(jobs.get(id)!.state).toBe("done");
    expect(jobs.get(id)!.output).toBe("out.png");
    // Finishing disarmed the terminate fallback: it must not rewrite the job afterwards.
    await Bun.sleep(40);
    expect(jobs.get(id)!.state).toBe("done");
  });

  test("a worker that never answers is terminated after the grace period and the message says so", async () => {
    const worker = new FakeWorker();
    const jobs = manager(worker, { cancelGraceMs: 20 });
    const { id } = jobs.submit(request());
    jobs.cancel(id);
    expect(worker.terminated).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(jobs.get(id)!.state).toBe("cancelled");
    expect(jobs.get(id)!.message).toContain("did not end within 0.02 s");
    expect(jobs.get(id)!.message).toContain("until the server is restarted");
    expect(worker.terminated).toBe(true);
  });

  test("a queued job is cancelled outright, without a worker", () => {
    const worker = new FakeWorker();
    const jobs = manager(worker);
    const first = jobs.submit(request());
    const second = jobs.submit(request());
    expect(jobs.get(second.id)!.state).toBe("queued");
    expect(jobs.cancel(second.id)!.state).toBe("cancelled");
    expect(jobs.get(first.id)!.state).toBe("running");
    expect(worker.sentOfType("cancel")).toHaveLength(0);
  });
});
