/** `--dlss-version VER`: an installed DLL version of the DLSS feature a command loads, found in the runtime catalog. */
import { buildRuntimeCatalog, featureByKey, type FeatureKey } from "../ngx/runtime-catalog.ts";
import { option } from "./args.ts";
import { usageError } from "./usage-error.ts";

/** The catalog folder of the `feature` version `--dlss-version` names (in full or by prefix), or undefined for the bundled runtime DLL. */
export function dlssVersionOption(args: string[], runtimeDir: string, feature: FeatureKey): string | undefined {
  const wantVersion = option(args, "--dlss-version");
  if (!wantVersion) return undefined;
  const descriptor = featureByKey(feature);
  const listed = buildRuntimeCatalog(runtimeDir).features.find((f) => f.id === descriptor.id);
  const match = listed?.versions.find((v) => v.version === wantVersion || v.version.startsWith(wantVersion));
  if (!match) usageError(`--dlss-version ${wantVersion} matches no installed ${descriptor.name} version; list them with 'bun run src/cli.ts versions'`);
  console.log(`using ${descriptor.name} ${match.version} (${match.source}) from ${match.dir}`);
  return match.dir;
}
