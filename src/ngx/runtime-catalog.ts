/**
 * Enumerates the DLSS runtime DLLs available to switch between, DLSS Swapper
 * style: our own per-feature runtime folders plus the read-only DLSS Swapper
 * cache. Each candidate DLL's version is read by static PE inspection
 * (version-info.ts) so nothing here loads native code or needs a GPU.
 *
 * The numeric FixedFileInfo version is the canonical identity and the sort key
 * (matching how DLSS Swapper names its folders).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseVersionInfo, type VersionInfo } from "../native/version-info.ts";

export type FeatureKey = "sr" | "fg" | "rr" | "nr";

/** Where a version came from. */
export type VersionSource = "runtime" | "swapper" | "installed";

export interface FeatureDescriptor {
  key: FeatureKey;
  /** NGX feature id. */
  id: number;
  /** Human readable feature name. */
  name: string;
  /** Canonical DLL filename NGX searches for. */
  dllName: string;
  /** Sub-folder under the runtime/ dir that holds this feature's DLL(s). */
  runtimeSubdir: string;
  /** DLSS Swapper cache "kind" folder, when the cache carries this feature. */
  swapperKind: "dlss" | "dlss_d" | "dlss_g" | null;
}

/**
 * The four switchable DLSS features. Ids and filenames per the NGX contract:
 * SR=1, FG=11, RR=13, NR=18.
 */
export const FEATURES: readonly FeatureDescriptor[] = [
  { key: "sr", id: 1, name: "DLSS Super Resolution", dllName: "nvngx_dlss.dll", runtimeSubdir: "dlss", swapperKind: "dlss" },
  { key: "fg", id: 11, name: "DLSS Frame Generation", dllName: "nvngx_dlssg.dll", runtimeSubdir: "dlssg", swapperKind: "dlss_g" },
  { key: "rr", id: 13, name: "DLSS Ray Reconstruction", dllName: "nvngx_dlssd.dll", runtimeSubdir: "dlssd", swapperKind: "dlss_d" },
  { key: "nr", id: 18, name: "DLSS Neural Rendering", dllName: "nvngx_dlssnr.dll", runtimeSubdir: "dlssnr", swapperKind: null },
];

export interface VersionEntry {
  /** Numeric FixedFileInfo version "a.b.c.d". */
  version: string;
  /** Absolute path to the DLL. */
  path: string;
  /** File size in MB, rounded to two decimals. */
  sizeMB: number;
  /** Directory that directly contains the DLL (added to the NGX search path). */
  dir: string;
  /** Enumeration source. */
  source: VersionSource;
  /** Monotonic sort key: (a<<48)|(b<<32)|(c<<16)|d, as a JSON-safe decimal string. */
  sortKey: string;
}

export interface FeatureManifest {
  id: number;
  name: string;
  dllName: string;
  versions: VersionEntry[];
}

export interface RuntimeManifest {
  features: FeatureManifest[];
}

const UNKNOWN_VERSION = "0.0.0.0";

/**
 * Pack a dotted numeric version into a monotonic 64-bit key. Non-numeric or
 * missing components collapse to 0, so a label version sorts below real ones.
 */
export function packVersionKey(version: string): bigint {
  const parts = version.split(".");
  const at = (i: number): bigint => {
    const n = Number.parseInt(parts[i] ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? BigInt(n) & 0xffffn : 0n;
  };
  return (at(0) << 48n) | (at(1) << 32n) | (at(2) << 16n) | at(3);
}

/** Extract a version like "310.7.129.0" from a DLSS Swapper folder name. */
export function parseVersionFromDirName(name: string): string | null {
  const match = /_v([0-9]+(?:\.[0-9]+){1,3})_/.exec(name);
  return match ? match[1]! : null;
}

/** Round a byte count to MB with two decimals. */
function toSizeMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Choose the canonical numeric version, falling back to a folder-name hint. */
function pickVersion(info: VersionInfo, folderHint: string | null): string {
  if (info.fileVersion) return info.fileVersion;
  if (folderHint) return folderHint;
  return UNKNOWN_VERSION;
}

/** Read + describe one DLL file into a VersionEntry, or null if unreadable. */
function describeDll(path: string, dir: string, source: VersionSource, folderHint: string | null): VersionEntry | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const info = parseVersionInfo(new Uint8Array(readFileSync(path)));
    const version = pickVersion(info, folderHint);
    return { version, path, dir, source, sizeMB: toSizeMB(stat.size), sortKey: packVersionKey(version).toString() };
  } catch {
    return null;
  }
}

/** List immediate sub-directory names of `dir`, or [] if it does not exist. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Enumerate versions of one feature from our runtime/ dir. Supports both the
 * flat legacy layout (runtime/<subdir>/<dll>, reported as "installed") and the
 * per-version layout (runtime/<subdir>/<version>/<dll>, reported as "runtime").
 */
export function enumerateRuntimeFeature(runtimeDir: string, feature: FeatureDescriptor): VersionEntry[] {
  const out: VersionEntry[] = [];
  const base = join(runtimeDir, feature.runtimeSubdir);
  const flat = join(base, feature.dllName);
  if (existsSync(flat)) {
    const entry = describeDll(flat, base, "installed", null);
    if (entry) out.push(entry);
  }
  for (const name of subdirs(base)) {
    const dir = join(base, name);
    const candidate = join(dir, feature.dllName);
    if (existsSync(candidate)) {
      const entry = describeDll(candidate, dir, "runtime", parseVersionFromDirName(name));
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** Resolve the DLSS Swapper dll cache root (never written to). */
export function swapperCacheDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "DLSS Swapper", "dlls");
}

/**
 * Enumerate versions of one feature from the DLSS Swapper cache:
 * <cache>/<kind>/<kind>_v<version>_<md5>/nvngx_<name>.dll
 */
export function enumerateSwapperFeature(feature: FeatureDescriptor, cacheDir = swapperCacheDir()): VersionEntry[] {
  if (!feature.swapperKind) return [];
  const out: VersionEntry[] = [];
  const kindDir = join(cacheDir, feature.swapperKind);
  for (const name of subdirs(kindDir)) {
    const dir = join(kindDir, name);
    const candidate = join(dir, feature.dllName);
    if (existsSync(candidate)) {
      const entry = describeDll(candidate, dir, "swapper", parseVersionFromDirName(name));
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** Sort descending by version, de-duping identical (version, source) pairs. */
function mergeVersions(entries: VersionEntry[]): VersionEntry[] {
  const seen = new Set<string>();
  const unique: VersionEntry[] = [];
  for (const entry of entries) {
    const dedupeKey = `${entry.version}|${entry.source}|${entry.dir}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(entry);
  }
  unique.sort((a, b) => {
    const ka = BigInt(a.sortKey);
    const kb = BigInt(b.sortKey);
    if (ka !== kb) return ka > kb ? -1 : 1;
    return a.source.localeCompare(b.source);
  });
  return unique;
}

/**
 * Build the full runtime manifest: for each feature, merge the runtime/ folders
 * and the DLSS Swapper cache into a version list sorted newest-first. Every fs
 * access is guarded, so a missing runtime dir or Swapper install just yields an
 * empty version list rather than throwing.
 */
export function buildRuntimeCatalog(runtimeDir: string, cacheDir = swapperCacheDir()): RuntimeManifest {
  const features: FeatureManifest[] = FEATURES.map((feature) => {
    const versions = mergeVersions([
      ...enumerateRuntimeFeature(runtimeDir, feature),
      ...enumerateSwapperFeature(feature, cacheDir),
    ]);
    return { id: feature.id, name: feature.name, dllName: feature.dllName, versions };
  });
  return { features };
}
