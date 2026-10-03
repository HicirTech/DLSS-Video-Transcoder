/**
 * The CLI's exit status through its real entry point, on the paths that only print a help page or an
 * error: 0 for a help page, EXIT_USAGE for a command line that names no command. No GPU: none of
 * these runs a command.
 */
import { describe, expect, test } from "bun:test";
import { EXIT_FAILED, EXIT_USAGE } from "../src/cli/usage-error.ts";
import { PROJECT_ROOT } from "../src/paths.ts";

/** Each test starts a few bun processes; a slow drive or a busy machine must not turn that into a failure. */
const SPAWN_TIMEOUT_MS = 30_000;

function runCli(...args: string[]): { status: number | null; out: string; err: string } {
  const proc = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
  return { status: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("a help page ends with exit status 0", () => {
  test("the overview, with or without a flag, and one command's page", () => {
    for (const args of [[], ["--help"], ["-h"], ["help"], ["help", "sr"], ["sr", "--help"]]) {
      const { status, err } = runCli(...args);
      expect(status, args.join(" ")).toBe(0);
      expect(err, args.join(" ")).toBe("");
    }
    expect(runCli("sr", "--help").out).toContain("--factor");
  }, SPAWN_TIMEOUT_MS);

  test("the overview states what each exit status means, with probe's meaning kept", () => {
    const { out } = runCli("help");
    expect(out).toContain("exit status:");
    expect(out).toContain("  0  the command succeeded (probe: neural rendering is ready)");
    expect(out).toContain(`  ${EXIT_FAILED}  the run failed (probe: neural rendering is not ready)`);
    expect(out).toContain(`  ${EXIT_USAGE}  the command line is wrong: an unknown command or option, a value an option does not accept, or a missing argument`);
  }, SPAWN_TIMEOUT_MS);
});

describe("a command the CLI does not have ends with the usage status", () => {
  test("whether it is asked about with help or with --help", () => {
    for (const args of [["help", "nosuch"], ["nosuch", "--help"]]) {
      const { status, out, err } = runCli(...args);
      expect(status, args.join(" ")).toBe(EXIT_USAGE);
      // The cause and the way out, on stderr, with no help page behind them.
      expect(err, args.join(" ")).toBe("error: unknown command 'nosuch'. Run 'bun run src/cli.ts help' for the list.\n");
      expect(out, args.join(" ")).toBe("");
    }
  }, SPAWN_TIMEOUT_MS);
});
