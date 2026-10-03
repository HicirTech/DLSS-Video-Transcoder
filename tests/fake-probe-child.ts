/**
 * A stand-in for the probe process (src/server/probe-child.ts) that the probe runner's tests start.
 * The first argument says what it does; none of it touches the GPU.
 *
 *   report <busyMs>                 Blocks this thread for busyMs, as the real probe's synchronous FFI
 *                                   does, then prints a stray line and a report.
 *   big                             Prints a report of several MB.
 *   error <message>                 Prints { error } and exits 1, as the real one does when it throws.
 *   silent <exitCode>               Prints a stray line and exits with exitCode.
 *   hang <markerFile>               Writes its pid to markerFile and blocks for a minute.
 */
import { writeFileSync } from "node:fs";

const [mode = "", first = ""] = process.argv.slice(2);

/** The fields the runner checks, and enough else to be told apart. */
function report(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, generatedAt: "2026-10-03T00:00:00.000Z", adapters: [], verdict: { neuralRenderingReady: true, reasons: [] }, ...extra };
}

/** A busy loop and not a sleep: native calls hold the thread, and a spinning one is the stricter stand-in. */
function blockFor(milliseconds: number): void {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {
    // blocked
  }
}

async function printLine(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`);
}

if (mode === "report") {
  blockFor(Number(first));
  console.log("a stray line from native code");
  await printLine(report());
} else if (mode === "big") {
  await printLine(report({ ngxCoreExports: Array.from({ length: 200_000 }, (_, index) => `export_${index}`) }));
} else if (mode === "error") {
  await printLine({ error: first });
  process.exit(1);
} else if (mode === "silent") {
  console.log("a stray line from native code");
  process.exit(Number(first));
} else if (mode === "hang") {
  writeFileSync(first, String(process.pid));
  blockFor(60_000);
}
process.exit(0);
