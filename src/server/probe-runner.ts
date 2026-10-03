/**
 * Runs the hardware probe in a process of its own, one probe at a time, and hands each request the
 * report of a probe that started after it asked. A process and not a Worker thread: the probe is
 * synchronous FFI that has to stay off the server's thread, but a Worker would share the caller
 * shim's single call slot with an sr or nr job's thread (core.ts) and would keep the NGX state that
 * is never shut down (probe.ts) in the server for good.
 */
import { join } from "node:path";
import type { ProbeReport } from "./api-types.ts";

/**
 * The script the child runs. Its last stdout line is a JSON object: the ProbeReport, or { error }
 * when the probe threw. Anything printed before that line is ignored.
 */
const PROBE_CHILD = join(import.meta.dir, "probe-child.ts");

/**
 * How long a probe may run before its process is killed. runProbe took 1.2 s on an RTX 5090 (issue
 * #103); the rest is a chosen margin, as for dlssg.ts's PROBE_TIMEOUT_MS, for a cold start from the
 * network drive the repo lives on. Without a limit, a probe stuck in a driver call would hold every
 * later request behind it.
 */
const PROBE_TIMEOUT_MS = 30_000;

/** The way out of every failure here: the same probe, in a terminal, where its output and any crash can be seen. */
const RUN_IN_TERMINAL = "Run `bun run probe` in a terminal (NR_TRACE=1 prints each native call before it runs) to see where it stops.";

interface ProbeProcessOptions {
  /** The command that runs the probe; tests hand in a stand-in. */
  command?: readonly string[];
  /** Overrides PROBE_TIMEOUT_MS (tests). */
  timeoutMs?: number;
}

/** The last non-empty line of `stdout` as a JSON object, or null when there is none. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const line = stdout.split(/\r?\n/).findLast((text) => text.trim() !== "");
  if (line === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One probe, run to the end in a new process; rejects with what went wrong and what to do about it. */
export async function probeInChildProcess(options: ProbeProcessOptions = {}): Promise<ProbeReport> {
  const command = options.command ?? [process.execPath, PROBE_CHILD];
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  // stderr stays the server's: NR_TRACE lines and a crash report belong in its console.
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "inherit", stdin: "ignore", windowsHide: true });
  const output = new Response(child.stdout).text().catch(() => "");
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const exitCode = await child.exited;
    // Checked before the output is read: a process that was stopped has no report to wait for.
    if (timedOut) throw new Error(`The probe did not finish within ${timeoutMs / 1000} s, so its process was stopped. Check that the NVIDIA driver responds (nvidia-smi), then ask for the probe again.`);
    const answer = lastJsonObject(await output);
    if (typeof answer?.error === "string") throw new Error(`The probe failed before it could report: ${answer.error} ${RUN_IN_TERMINAL}`);
    // Every ProbeReport has these two; a stray JSON line from native code is unlikely to.
    if (typeof answer?.ok === "boolean" && Array.isArray(answer.adapters)) return answer as unknown as ProbeReport;
    throw new Error(`The probe process ended with exit code ${exitCode} without reporting. ${RUN_IN_TERMINAL}`);
  } finally {
    clearTimeout(timer);
    try {
      child.kill();
    } catch {
      // the process has already exited, which is the normal case
    }
  }
}

/** Serialises probes: one runs at a time, and the requests that arrive while it runs share the one after it. */
export class ProbeRunner {
  /** The probe that follows the running one, shared by every request that asked meanwhile; null once it has started. */
  private next: Promise<ProbeReport> | null = null;
  /** Settles when the latest probe has ended, whichever way. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly probe: () => Promise<ProbeReport> = probeInChildProcess) {}

  run(): Promise<ProbeReport> {
    if (this.next) return this.next;
    const started = this.tail.then(() => {
      this.next = null;
      return this.probe();
    });
    this.next = started;
    this.tail = started.then(() => {}, () => {});
    return started;
  }
}
