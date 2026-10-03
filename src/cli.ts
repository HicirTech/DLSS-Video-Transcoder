/**
 * Command line entry point: hands each command to its handler in cli/ and turns any failure into a
 * one-line error.
 */
import { flag } from "./cli/args.ts";
import { fgCommand } from "./cli/fg-command.ts";
import { forwarderCommand } from "./cli/forwarder-command.ts";
import { printHelp, unknownCommand } from "./cli/help.ts";
import { nrCommand } from "./cli/nr-command.ts";
import { probeCommand } from "./cli/probe-command.ts";
import { srCommand } from "./cli/sr-command.ts";
import { EXIT_FAILED, EXIT_USAGE, UsageError } from "./cli/usage-error.ts";
import { versionsCommand } from "./cli/versions-command.ts";

const COMMAND_HANDLERS = new Map<string, (args: string[]) => Promise<void>>([
  ["probe", probeCommand],
  ["forwarder", forwarderCommand],
  ["sr", srCommand],
  ["nr", nrCommand],
  ["fg", fgCommand],
  ["versions", versionsCommand],
]);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "help") {
    printHelp(args.filter((a) => !a.startsWith("-"))[0]);
    process.exit(0);
  }
  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }
  const handler = COMMAND_HANDLERS.get(command);
  if (!handler) unknownCommand(command);
  if (flag(args, "--help") || flag(args, "-h")) {
    printHelp(command);
    process.exit(0);
  }
  await handler(args);
}

// A wrong command line ends with EXIT_USAGE and the command's help page; any other failure ends
// with EXIT_FAILED. Either should tell the user what to do, not print a stack trace through them.
// NR_DEBUG=1 keeps the stack of a failed run for diagnosing the tool itself.
try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}`);
    if (error.command !== undefined) {
      console.error("");
      printHelp(error.command);
    }
    process.exit(EXIT_USAGE);
  }
  if (process.env.NR_DEBUG) throw error;
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_FAILED);
}
