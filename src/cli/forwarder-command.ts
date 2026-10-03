/** The `forwarder` command: writes the x64 nvngx.dll shim that makes NGX accept our in-process calls. */
import { buildForwarderDll } from "../ngx/forwarder.ts";
import { shimPath } from "../ngx/forwarder-runtime.ts";
import { callerDir, DEFAULT_RUNTIME_DIR } from "../paths.ts";
import { option, positionalArgs } from "./args.ts";
import { commandSpec } from "./commands.ts";

export async function forwarderCommand(args: string[]): Promise<void> {
  // forwarder takes no positionals; validate before anything is written.
  positionalArgs(args, commandSpec("forwarder"));
  const out = option(args, "--out") ?? shimPath(callerDir(DEFAULT_RUNTIME_DIR));
  const built = buildForwarderDll();
  await Bun.write(out, built.bytes);
  console.log(`wrote ${built.bytes.length} bytes to ${out}`);
  for (const e of built.exports) console.log(`  ${e.name} @ rva 0x${e.rva.toString(16)}`);
}
