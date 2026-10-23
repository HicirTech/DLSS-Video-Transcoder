/** `--dlss-version VER` and `video`'s per-step `--<step>-version VER`: an installed DLL version found in the runtime catalog. */
import { buildRuntimeCatalog, featureByKey, type FeatureKey, type VersionEntry } from "../ngx/runtime-catalog.ts";
import type { StepKind } from "../server/api-types.ts";
import { option } from "./args.ts";
import { usageError } from "./usage-error.ts";

/** The catalog folder of the `feature` version `--dlss-version` names (in full or by its leading components), or undefined for the bundled runtime DLL. */
export function dlssVersionOption(args: string[], runtimeDir: string, feature: FeatureKey): string | undefined {
  return versionFolder({ args, name: "--dlss-version", runtimeDir, feature });
}

/** The same for one step of a `video` job, from `--sr-version`, `--nr-version` or `--fg-version`: a step's key is its feature's key. */
export function stepVersionOption(args: string[], runtimeDir: string, step: StepKind): string | undefined {
  return versionFolder({ args, name: `--${step}-version`, runtimeDir, feature: step });
}

function versionFolder({ args, name, runtimeDir, feature }: { args: string[]; name: string; runtimeDir: string; feature: FeatureKey }): string | undefined {
  const wantVersion = option(args, name);
  if (!wantVersion) return undefined;
  const descriptor = featureByKey(feature);
  const listed = buildRuntimeCatalog(runtimeDir).features.find((f) => f.id === descriptor.id);
  const match = matchVersion(listed?.versions ?? [], wantVersion);
  if (!match) usageError(`${name} ${wantVersion} matches no installed ${descriptor.name} version; list them with 'bun run src/cli.ts versions'`);
  console.log(`using ${descriptor.name} ${match.version} (${match.source}) from ${match.dir}`);
  return match.dir;
}

/**
 * The entry `wantVersion` names in a newest-first list: that exact version, else the newest whose leading dotted
 * components it is, so "310.7" picks the newest 310.7.x and "310.7.1" never picks 310.7.129.0.
 */
export function matchVersion(versions: readonly VersionEntry[], wantVersion: string): VersionEntry | undefined {
  return versions.find((entry) => entry.version === wantVersion) ?? versions.find((entry) => entry.version.startsWith(`${wantVersion}.`));
}
