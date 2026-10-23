/**
 * Manual GPU diagnostic (not part of `bun test`): which neural-rendering
 * settings does the installed nvngx_dlssnr.dll actually honour?
 *
 * Each setting is swept on its own with everything else at its default, and the
 * output is hashed. A setting whose values all produce the same bytes is being
 * ignored by the runtime, however faithfully the code passes it. Re-run this
 * after a DLL update before changing what the CLI, README or UI claim.
 *
 *   bun run tests/diag-nr-settings.ts
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/ngx/nr.ts";
import { DEFAULT_RUNTIME_DIR } from "../src/paths.ts";
import { processImage } from "../src/pipeline/image.ts";
import { DEFAULT_NR_SETTINGS, NR_PRESETS, NR_STYLES, type NrSettings, SETTING_RANGES } from "../src/server/api-types.ts";

const input = Bun.argv[2] ?? "W:/GPUVideoProcessor/1.png";
const runtimeDir = DEFAULT_RUNTIME_DIR;
const out = mkdtempSync(join(tmpdir(), "nr-settings-"));

async function hashFor(label: string, overrides: Partial<NrSettings>): Promise<string> {
  const output = join(out, `${label.replace(/[^\w.-]/g, "_")}.png`);
  await processImage({ input, output, neuralRendering: { settings: { ...DEFAULT_NR_SETTINGS, ...overrides } }, runtimeDir });
  return createHash("sha256").update(new Uint8Array(await Bun.file(output).arrayBuffer())).digest("hex").slice(0, 16);
}

/** A numeric setting's SETTING_RANGES end points with the sample points between them. */
function across(field: "intensity" | "localTone" | "localStructure" | "skinStructure", interior: number[]): number[] {
  const { min, max } = SETTING_RANGES[field];
  return [min, ...interior, max];
}

const SWEEPS: [keyof NrSettings, (number | boolean)[]][] = [
  ["intensity", across("intensity", [0.5, 1, 1.5])],
  ["style", [...NR_STYLES]],
  ["preset", [...NR_PRESETS]],
  ["localTone", across("localTone", [1])],
  ["localStructure", across("localStructure", [1])],
  ["skinStructure", across("skinStructure", [0, 1])],
  ["autoMask", [false, true]],
  ["uiCorrection", [false, true]],
];

console.log(`input ${input}`);
console.log("A setting with one distinct hash across its whole range is ignored by this runtime.\n");
const ignored: string[] = [];
try {
  for (const [name, values] of SWEEPS) {
    const hashes: string[] = [];
    for (const value of values) hashes.push(await hashFor(`${name}-${value}`, { [name]: value } as Partial<NrSettings>));
    const distinct = new Set(hashes).size;
    if (distinct === 1) ignored.push(String(name));
    console.log(`  ${String(name).padEnd(16)} ${values.length} values -> ${distinct} distinct  ${distinct === 1 ? "IGNORED" : ""}`);
    console.log(`      ${values.map((value, index) => `${value}=${hashes[index]!.slice(0, 8)}`).join("  ")}`);
  }
  console.log(`\nignored by this runtime: ${ignored.length ? ignored.join(", ") : "(none)"}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(0);
