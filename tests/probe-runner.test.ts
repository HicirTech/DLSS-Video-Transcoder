/**
 * The probe's process and queue (src/server/probe-runner.ts), run against tests/fake-probe-child.ts
 * in place of the real probe: what a request gets back for each way the probe can end, that probes
 * run one at a time, and that the server keeps answering while the probe's thread is blocked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeReport } from "../src/server/api-types.ts";
import { ProbeRunner, probeInChildProcess } from "../src/server/probe-runner.ts";

const FAKE_CHILD = join(import.meta.dir, "fake-probe-child.ts");
const fake = (...args: string[]): string[] => [process.execPath, FAKE_CHILD, ...args];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A marker file the stand-in writes into, in a folder removed after the test. */
function markerFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "probe-runner-"));
  dirs.push(dir);
  return join(dir, "marker.txt");
}

async function eventually(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`still waiting for ${what} after ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("probeInChildProcess", () => {
  test("returns the report on the last line of the child's stdout, whatever came before it", async () => {
    const report = await probeInChildProcess({ command: fake("report", "0") });
    // The child's JSON as it printed it, so the route's response is the report's own shape.
    expect(report).toEqual({ ok: true, generatedAt: "2026-10-03T00:00:00.000Z", adapters: [], verdict: { neuralRenderingReady: true, reasons: [] } } as unknown as ProbeReport);
  });

  test("a report of several MB arrives whole", async () => {
    const report = await probeInChildProcess({ command: fake("big") });
    const exports = (report as unknown as { ngxCoreExports: string[] }).ngxCoreExports;
    expect(exports).toHaveLength(200_000);
    expect(exports.at(-1)).toBe("export_199999");
  });

  test("a probe that threw is reported with its message and the way out", async () => {
    await expect(probeInChildProcess({ command: fake("error", "EACCES: permission denied, mkdir 'logs'") })).rejects.toThrow(
      "The probe failed before it could report: EACCES: permission denied, mkdir 'logs' Run `bun run probe` in a terminal",
    );
  });

  test("a process that ends with no report names its exit code and the way out", async () => {
    await expect(probeInChildProcess({ command: fake("silent", "3") })).rejects.toThrow("The probe process ended with exit code 3 without reporting. Run `bun run probe` in a terminal");
    await expect(probeInChildProcess({ command: fake("silent", "0") })).rejects.toThrow("exit code 0 without reporting");
  });

  test("a probe that runs past its limit is stopped, and its process with it", async () => {
    const marker = markerFile();
    await expect(probeInChildProcess({ command: fake("hang", marker), timeoutMs: 1500 })).rejects.toThrow("The probe did not finish within 1.5 s, so its process was stopped.");
    const pid = Number(readFileSync(marker, "utf8"));
    await eventually(() => !isRunning(pid), `process ${pid} to end`);
  });

  test("a command that cannot start is an error, not a hang", async () => {
    await expect(probeInChildProcess({ command: [join(tmpdir(), "no-such-folder-for-the-probe-test", "bun.exe")] })).rejects.toThrow();
  });
});

describe("ProbeRunner", () => {
  function report(label: string): ProbeReport {
    return { ok: true, label } as unknown as ProbeReport;
  }

  /** A probe whose runs are started and finished by the test, and that counts how many overlap. */
  function manualProbe() {
    const state = { started: 0, running: 0, mostRunning: 0, finish: [] as Array<(value: ProbeReport | Error) => void> };
    const probe = (): Promise<ProbeReport> =>
      new Promise((resolve, reject) => {
        const run = ++state.started;
        state.mostRunning = Math.max(state.mostRunning, ++state.running);
        state.finish[run - 1] = (value) => {
          state.running--;
          if (value instanceof Error) reject(value);
          else resolve(value);
        };
      });
    return { state, probe };
  }

  test("a request that finds nothing running starts a probe at once", async () => {
    const { state, probe } = manualProbe();
    const runner = new ProbeRunner(probe);
    const first = runner.run();
    await Bun.sleep(0);
    expect(state.started).toBe(1);
    state.finish[0]!(report("one"));
    expect(await first).toEqual(report("one"));
  });

  test("probes run one at a time, and the requests that arrive while one runs share the next", async () => {
    const { state, probe } = manualProbe();
    const runner = new ProbeRunner(probe);
    const first = runner.run();
    await Bun.sleep(0);
    const second = runner.run();
    const third = runner.run();
    await Bun.sleep(0);
    expect(state.started).toBe(1);

    state.finish[0]!(report("one"));
    expect(await first).toEqual(report("one"));
    await Bun.sleep(0);
    expect(state.started).toBe(2);
    state.finish[1]!(report("two"));
    expect(await second).toEqual(report("two"));
    expect(await third).toBe(await second);
    expect(state.mostRunning).toBe(1);
  });

  test("requests that arrive together share one probe", async () => {
    const { state, probe } = manualProbe();
    const runner = new ProbeRunner(probe);
    const both = [runner.run(), runner.run()];
    await Bun.sleep(0);
    state.finish[0]!(report("one"));
    const [first, second] = await Promise.all(both);
    expect(first).toBe(second);
    expect(state.started).toBe(1);
  });

  test("a request after the probes have ended starts its own", async () => {
    const { state, probe } = manualProbe();
    const runner = new ProbeRunner(probe);
    const first = runner.run();
    await Bun.sleep(0);
    state.finish[0]!(report("one"));
    await first;
    const second = runner.run();
    await Bun.sleep(0);
    expect(state.started).toBe(2);
    state.finish[1]!(report("two"));
    expect(await second).toEqual(report("two"));
  });

  test("a failed probe fails the requests that were waiting on it and leaves the queue working", async () => {
    const { state, probe } = manualProbe();
    const runner = new ProbeRunner(probe);
    const first = runner.run();
    await Bun.sleep(0);
    const second = runner.run();
    state.finish[0]!(new Error("the probe died"));
    await expect(first).rejects.toThrow("the probe died");
    await Bun.sleep(0);
    state.finish[1]!(report("two"));
    expect(await second).toEqual(report("two"));
    const third = runner.run();
    await Bun.sleep(0);
    state.finish[2]!(report("three"));
    expect(await third).toEqual(report("three"));
  });

  test("the server keeps answering while the probe's own thread is blocked", async () => {
    const BLOCKED_MS = 2000;
    const runner = new ProbeRunner(() => probeInChildProcess({ command: fake("report", String(BLOCKED_MS)) }));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/api/probe": async () => Response.json(await runner.run()),
        "/api/ping": () => new Response("pong"),
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const startedAt = performance.now();
      let probeEnded = false;
      const probing = fetch(`${base}/api/probe`).then((response) => {
        probeEnded = true;
        return response.json() as Promise<ProbeReport>;
      });
      // From the moment the probe is asked for until it answers: a server whose thread the probe held would not answer a ping until it let go.
      const pingLatencies: number[] = [];
      while (!probeEnded) {
        const pingedAt = performance.now();
        expect(await (await fetch(`${base}/api/ping`)).text()).toBe("pong");
        pingLatencies.push(performance.now() - pingedAt);
        await Bun.sleep(20);
      }
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(BLOCKED_MS);
      expect(pingLatencies.length).toBeGreaterThan(20);
      expect(Math.max(...pingLatencies)).toBeLessThan(500);
      expect(await probing).toMatchObject({ ok: true });
    } finally {
      void server.stop(true);
    }
  });
});
