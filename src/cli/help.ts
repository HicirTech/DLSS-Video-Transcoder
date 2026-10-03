/** Renders the CLI overview and the per-command help pages from the command table. */
import { ADAPTER_OPT, COMMANDS, RUNTIME_OPT, type CommandSpec } from "./commands.ts";
import { usageError } from "./usage-error.ts";

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function printOverview(): void {
  const lines: string[] = [];
  lines.push("neural-render-ts — DLSS image & video processing CLI");
  lines.push("");
  lines.push("usage: bun run src/cli.ts <command> [args] [options]");
  lines.push("       bun run src/cli.ts help <command>     detailed help for one command");
  lines.push("");
  lines.push("commands:");
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const c of COMMANDS) lines.push(`  ${pad(c.name, width)}  ${c.summary}`);
  lines.push("");
  // Only the commands whose own help lists these accept them; anything else is a
  // usage error, so do not promise them everywhere.
  lines.push("common options (each command's help lists the ones it accepts):");
  lines.push(`  ${pad(ADAPTER_OPT.flag, 20)} ${ADAPTER_OPT.desc} (default ${ADAPTER_OPT.def})`);
  lines.push(`  ${pad(RUNTIME_OPT.flag, 20)} ${RUNTIME_OPT.desc} (default ${RUNTIME_OPT.def})`);
  lines.push(`  ${pad("--help, -h", 20)} show help for the CLI or the given command`);
  console.log(lines.join("\n"));
}

function printCommandHelp(spec: CommandSpec): void {
  const lines: string[] = [];
  lines.push(`${spec.name} — ${spec.summary}`);
  lines.push("");
  lines.push(`usage: ${spec.usage}`);
  if (spec.args?.length) {
    lines.push("");
    lines.push("arguments:");
    const w = Math.max(...spec.args.map((a) => a.name.length));
    for (const a of spec.args) lines.push(`  ${pad(a.name, w)}  ${a.desc}`);
  }
  if (spec.options.length) {
    lines.push("");
    lines.push("options:");
    const w = Math.max(...spec.options.map((o) => o.flag.length));
    for (const o of spec.options) {
      lines.push(`  ${pad(o.flag, w)}  ${o.desc}${o.def !== undefined ? `  (default ${o.def})` : ""}`);
    }
  }
  if (spec.notes?.length) {
    lines.push("");
    for (const n of spec.notes) lines.push(`note: ${n}`);
  }
  console.log(lines.join("\n"));
}

/** The usage error for a command name the CLI does not have. */
export function unknownCommand(name: string): never {
  usageError(`unknown command '${name}'. Run 'bun run src/cli.ts help' for the list.`);
}

/** Prints the overview, or one command's page. */
export function printHelp(command?: string): void {
  if (!command) {
    printOverview();
    return;
  }
  const spec = COMMANDS.find((c) => c.name === command);
  if (!spec) unknownCommand(command);
  printCommandHelp(spec);
}
