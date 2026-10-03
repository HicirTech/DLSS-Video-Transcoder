/**
 * The process behind GET /api/probe (probe-runner.ts): runs the hardware probe and prints its
 * report, or why it threw, as the last line of stdout. It reads its folders from the environment
 * the server does (paths.ts), so it probes what the server would.
 */
import { runProbe } from "../ngx/probe.ts";
import { APP_DATA_DIR, RUNTIME_DIR } from "../paths.ts";

async function main(): Promise<number> {
  let answer: unknown;
  let exitCode = 0;
  try {
    answer = await runProbe({ runtimeDir: RUNTIME_DIR, appDataPath: APP_DATA_DIR });
  } catch (error) {
    answer = { error: error instanceof Error ? error.message : String(error) };
    exitCode = 1;
  }
  // Awaited, so the whole line is in the pipe before the exit below.
  await Bun.write(Bun.stdout, `${JSON.stringify(answer)}\n`);
  return exitCode;
}

// NGX is never shut down (core.ts): the exit is what releases it.
process.exit(await main());
