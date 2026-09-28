/**
 * The abort handshake between a pipeline thread and its workers
 * (src/pipeline/worker-abort.ts): the waiting side with stand-in workers, and
 * the answering side against a real child process.
 */
import { describe, expect, test } from "bun:test";
import { abortWorkers, answerAbort } from "../src/pipeline/worker-abort.ts";
import { FakeWorker } from "./fake-worker.ts";

describe("abortWorkers", () => {
  test("resolves only once every worker has acknowledged the abort", async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    let settled = false;
    const done = abortWorkers([first.asWorker(), second.asWorker()], 1000).then(() => { settled = true; });
    expect(first.sent).toEqual([{ type: "abort" }]);
    expect(second.sent).toEqual([{ type: "abort" }]);
    first.reply({ type: "aborted" });
    // A whole task, not a microtask: resolution takes several promise hops.
    await Bun.sleep(0);
    expect(settled).toBe(false);
    second.reply({ type: "aborted" });
    await done;
    expect(settled).toBe(true);
  });

  test("a worker that crashes during the handshake counts as stopped at once, not at the timeout", async () => {
    const worker = new FakeWorker();
    const done = abortWorkers([worker.asWorker()], 5000).then(() => "stopped");
    worker.crash("gone");
    expect(await Promise.race([done, Bun.sleep(200).then(() => "timed out")])).toBe("stopped");
  });

  test("gives up after the timeout when a worker never answers", async () => {
    const mute = new FakeWorker();
    const started = performance.now();
    await abortWorkers([mute.asWorker()], 30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe("answerAbort", () => {
  test("kills the child, waits for it to exit, releases, then acknowledges", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const order: string[] = [];
    void child.exited.then(() => order.push("exited"));
    const scope = new FakeWorker();
    await answerAbort(scope.asWorker(), child, () => { order.push("released"); });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(order).toEqual(["exited", "released"]);
    expect(scope.sent).toEqual([{ type: "aborted" }]);
  });

  test("without a child it still releases and acknowledges, and a failing release does not stop the reply", async () => {
    const scope = new FakeWorker();
    await answerAbort(scope.asWorker(), null, () => { throw new Error("encoder already closed"); });
    expect(scope.sent).toEqual([{ type: "aborted" }]);
  });
});
