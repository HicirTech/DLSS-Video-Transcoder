/** The `probe` command: reports whether neural rendering is ready on this machine and exits 0 only then. */
import { PROBE_ENTRIES, PROBE_INITS, runProbe } from "../ngx/probe.ts";
import { APP_DATA_DIR } from "../paths.ts";
import { adapterOption, choiceOption, flag, positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec } from "./commands.ts";
import { printProbe } from "./probe-report.ts";

export async function probeCommand(args: string[]): Promise<void> {
  // probe takes no positionals; validate the flag set before the GPU is touched.
  positionalArgs(args, commandSpec("probe"));
  const report = await runProbe({
    adapterIndex: adapterOption(args),
    runtimeDir: runtimeDirOption(args),
    appDataPath: APP_DATA_DIR,
    projectInit: flag(args, "--project-init"),
    // No fallback: probe.ts owns both defaults, so repeating them here would be a second copy.
    entry: choiceOption(args, "--entry", PROBE_ENTRIES),
    nullFeatureInfo: flag(args, "--null-feature-info"),
    init: choiceOption(args, "--init", PROBE_INITS),
    requirements: !flag(args, "--no-requirements"),
    debugLayer: flag(args, "--debug-layer"),
  });
  if (flag(args, "--json")) console.log(JSON.stringify(report, null, 2));
  else printProbe(report);
  if (flag(args, "--log")) for (const line of report.log) console.log("  | " + line);
  // The exit code answers the question the command exists to answer, so a
  // run that prints "ready: NO" cannot look like success to a calling script.
  process.exit(report.ok && report.verdict.neuralRenderingReady ? 0 : 1);
}
