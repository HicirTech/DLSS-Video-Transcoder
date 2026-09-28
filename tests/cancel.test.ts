/** Cooperative cancellation's checkpoints (src/pipeline/cancel.ts). */
import { describe, expect, test } from "bun:test";
import { JobCancelledError, raceAbort, throwIfAborted, throwIfAbortedAfterYield } from "../src/pipeline/cancel.ts";

describe("throwIfAborted", () => {
  test("is a no-op without a signal and before the signal aborts", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  test("throws a cancellation once the signal aborts", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(JobCancelledError);
  });
});

describe("JobCancelledError", () => {
  test("carries the frames written, 0 by default", () => {
    expect(new JobCancelledError(42).framesWritten).toBe(42);
    expect(new JobCancelledError().framesWritten).toBe(0);
  });
});

describe("throwIfAbortedAfterYield", () => {
  // A cancel reaches a job thread as a message; a task-queued abort stands in for it here.
  test("sees an abort queued as a task while the caller was busy", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    const busyUntil = performance.now() + 20;
    while (performance.now() < busyUntil) { /* synchronous work, like a DLSS pass */ }
    expect(controller.signal.aborted).toBe(false);
    await expect(throwIfAbortedAfterYield(controller.signal)).rejects.toBeInstanceOf(JobCancelledError);
  });

  test("resolves when nothing aborted", async () => {
    await throwIfAbortedAfterYield(new AbortController().signal);
    await throwIfAbortedAfterYield(undefined);
  });
});

describe("raceAbort", () => {
  test("rejects with a cancellation as soon as the signal aborts, however long the work takes", async () => {
    const controller = new AbortController();
    const never = new Promise<number>(() => {});
    const raced = raceAbort(controller.signal, never);
    controller.abort();
    await expect(raced).rejects.toBeInstanceOf(JobCancelledError);
  });

  test("passes the work's own result or failure through while not aborted", async () => {
    const controller = new AbortController();
    expect(await raceAbort(controller.signal, Promise.resolve(7))).toBe(7);
    await expect(raceAbort(controller.signal, Promise.reject(new Error("step failed")))).rejects.toThrow("step failed");
  });
});
