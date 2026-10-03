/** The `versions` command: lists every DLSS runtime DLL found, per feature. */
import { buildRuntimeCatalog } from "../ngx/runtime-catalog.ts";
import { positionalArgs, runtimeDirOption } from "./args.ts";
import { commandSpec } from "./commands.ts";

export async function versionsCommand(args: string[]): Promise<void> {
  // versions takes no positionals; validate before the catalog is built.
  positionalArgs(args, commandSpec("versions"));
  const catalog = buildRuntimeCatalog(runtimeDirOption(args));
  for (const feature of catalog.features) {
    console.log(`feature ${feature.id}  ${feature.name}  (${feature.dllName})  ${feature.versions.length} version(s)`);
    for (const v of feature.versions) {
      console.log(`  ${v.version.padEnd(14)} ${v.source.padEnd(10)} ${String(v.sizeMB).padStart(7)} MB  ${v.dir}`);
    }
  }
}
