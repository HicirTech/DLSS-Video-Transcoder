/**
 * Command line entry point.
 *
 *   bun run src/cli.ts probe [--json] [--adapter N] [--runtime DIR] [--project-init] [--debug-layer]
 *   bun run src/cli.ts forwarder [--out PATH]
 *   bun run src/cli.ts sr <input.png> [output.png] [--factor 2] [--preset L]
 */
import { basename, dirname, extname, join } from "node:path";
import { decodePng, encodePng, isPng } from "./codec/png.ts";
import { buildForwarderDll } from "./ngx/forwarder.ts";
import { runProbe } from "./ngx/probe.ts";
import { DlssNrSession } from "./ngx/nr-render.ts";
import { buildRuntimeCatalog } from "./ngx/runtime-catalog.ts";
import { DlssSrSession } from "./ngx/sr.ts";
import { DEFAULT_NR_SETTINGS } from "./server/api-types.ts";
import { DlssRenderPreset, DLSS_RATIO } from "./ngx/results.ts";
import { openGpu } from "./pipeline/gpu.ts";
import { evenSize } from "./pipeline/resize.ts";

const ROOT = join(import.meta.dir, "..");

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printProbe(report: Awaited<ReturnType<typeof runProbe>>): void {
  const lines: string[] = [];
  lines.push(`Neural Render probe  (${report.generatedAt})`);
  lines.push(`Bun ${report.platform.bun} on ${report.platform.os}`);
  lines.push("");
  lines.push("Adapters:");
  for (const a of report.adapters) {
    const mark = a.index === report.selectedAdapter ? "*" : " ";
    lines.push(`  ${mark} [${a.index}] ${a.name}  vendor=0x${a.vendorId.toString(16)}  vram=${a.dedicatedVideoMemoryMB} MB  luid=${a.luid}${a.software ? "  (software)" : ""}`);
  }
  lines.push(`D3D12 device: ${report.device.created ? "created" : "FAILED"}${report.device.hresult && !report.device.created ? ` (${report.device.hresult})` : ""}`);
  lines.push(`Driver: ${report.driver.version ?? "unknown"}`);
  lines.push(`NGX core: ${report.driver.ngxCorePath ?? "not found"}${report.driver.ngxCoreExports.length ? `  (${report.driver.ngxCoreExports.length} exports)` : ""}`);
  lines.push(`NGX init: ${report.ngxInit.attempted ? report.ngxInit.result : "not attempted"}`);
  lines.push("");
  lines.push("Features (GetFeatureRequirements):");
  for (const f of report.features) {
    lines.push(`  ${String(f.id).padStart(2)} ${f.name.padEnd(18)} ${f.support}${f.minHwArchitecture ? `  minArch=0x${f.minHwArchitecture.toString(16)}` : ""}${f.minOsVersion ? `  minOS=${f.minOsVersion}` : ""}`);
  }
  const caps = Object.entries(report.capabilities);
  if (caps.length) {
    lines.push("");
    lines.push("Capability parameters:");
    for (const [k, v] of caps) lines.push(`  ${k} = ${v === null ? "(absent)" : v}`);
  }
  lines.push("");
  lines.push(`Runtime folder: ${report.runtime.folder}`);
  for (const f of report.runtime.files) {
    lines.push(`  ${f.present ? "present" : "missing"}  ${f.name.padEnd(18)} ${f.role}${f.sizeMB !== null ? `  ${f.sizeMB} MB` : ""}${f.exports ? `  ${f.exports.length} exports` : ""}`);
  }
  lines.push(`Forwarder: ${report.forwarder.selfTest ?? "not built"}`);
  lines.push("");
  lines.push(`Neural rendering ready: ${report.verdict.neuralRenderingReady ? "YES" : "NO"}`);
  for (const r of report.verdict.reasons) lines.push(`  - ${r}`);
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "probe": {
      const report = await runProbe({
        adapterIndex: option(args, "--adapter") !== undefined ? Number(option(args, "--adapter")) : undefined,
        runtimeDir: option(args, "--runtime") ?? join(ROOT, "runtime"),
        appDataPath: join(ROOT, "logs"),
        projectInit: flag(args, "--project-init"),
        entry: option(args, "--entry") === "loader" ? "loader" : "core",
        nullFeatureInfo: flag(args, "--null-feature-info"),
        init: (option(args, "--init") as "ext" | "plain" | "spy" | undefined) ?? "ext",
        requirements: !flag(args, "--no-requirements"),
        debugLayer: flag(args, "--debug-layer"),
      });
      if (flag(args, "--json")) console.log(JSON.stringify(report, null, 2));
      else printProbe(report);
      if (flag(args, "--log")) for (const line of report.log) console.log("  | " + line);
      process.exit(report.ok ? 0 : 1);
    }
    case "forwarder": {
      const out = option(args, "--out") ?? join(ROOT, "runtime", "caller", "nvngx.dll");
      const built = buildForwarderDll();
      await Bun.write(out, built.bytes);
      console.log(`wrote ${built.bytes.length} bytes to ${out}`);
      for (const e of built.exports) console.log(`  ${e.name} @ rva 0x${e.rva.toString(16)}`);
      return;
    }
    case "sr": {
      const positional = args.filter((a) => !a.startsWith("--"));
      const input = positional[0];
      if (!input) {
        console.error("usage: bun run src/cli.ts sr <input.png> [output.png] [--factor 2] [--preset L]");
        process.exit(1);
      }
      const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
      if (!isPng(bytes)) {
        console.error(`${input}: only PNG input is supported by the sr command`);
        process.exit(1);
      }
      const image = decodePng(bytes);
      const factor = Number(option(args, "--factor") ?? 2);
      // Pick the DLSS PerfQuality whose fixed ratio is nearest the requested factor.
      const quality = Number(
        Object.entries(DLSS_RATIO).reduce((best, [q, ratio]) =>
          Math.abs(ratio - factor) < Math.abs(DLSS_RATIO[Number(best)]! - factor) ? q : best, "0"),
      );
      const presetName = (option(args, "--preset") ?? "L").toUpperCase() as keyof typeof DlssRenderPreset;
      const preset = DlssRenderPreset[presetName] ?? DlssRenderPreset.L;
      const outputWidth = evenSize(image.width * factor);
      const outputHeight = evenSize(image.height * factor);
      const output = positional[1] ?? join(dirname(input), `${basename(input, extname(input))}.dlss.png`);

      const runtimeDir = option(args, "--runtime") ?? join(ROOT, "runtime");
      let dllDir: string | undefined;
      const wantVersion = option(args, "--dlss-version");
      if (wantVersion) {
        const sr = buildRuntimeCatalog(runtimeDir).features.find((f) => f.id === 1);
        const match = sr?.versions.find((v) => v.version === wantVersion || v.version.startsWith(wantVersion));
        if (!match) {
          console.error(`DLSS SR version ${wantVersion} not found; run 'bun run src/cli.ts versions' to list`);
          process.exit(1);
        }
        dllDir = match.dir;
        console.log(`using DLSS SR ${match.version} (${match.source}) from ${match.dir}`);
      }

      const session = openGpu({ adapterIndex: option(args, "--adapter") !== undefined ? Number(option(args, "--adapter")) : undefined });
      const started = performance.now();
      const sr = DlssSrSession.open(session, {
        renderWidth: image.width,
        renderHeight: image.height,
        outputWidth,
        outputHeight,
        quality,
        preset,
        runtimeDir,
        dllDir,
      });
      const rgba = sr.evaluate(image.rgba, true);
      await Bun.write(output, encodePng({ width: outputWidth, height: outputHeight, rgba }, { level: 6 }));
      sr.close();
      console.log(`DLSS SR: ${image.width}x${image.height} -> ${outputWidth}x${outputHeight} (quality ${quality}, preset ${presetName}) in ${(performance.now() - started).toFixed(1)} ms`);
      console.log(`wrote ${output}`);
      // The driver core's Shutdown1 is skipped; exit the process to reclaim NGX.
      process.exit(0);
    }
    case "nr": {
      const positional = args.filter((a) => !a.startsWith("--"));
      const input = positional[0];
      if (!input) {
        console.error("usage: bun run src/cli.ts nr <input.png> [output.png] [--intensity 1.6] [--preset 0]");
        process.exit(1);
      }
      const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
      if (!isPng(bytes)) {
        console.error(`${input}: only PNG input is supported by the nr command`);
        process.exit(1);
      }
      const image = decodePng(bytes);
      const output = positional[1] ?? join(dirname(input), `${basename(input, extname(input))}.nr.png`);
      const settings = {
        ...DEFAULT_NR_SETTINGS,
        intensity: Number(option(args, "--intensity") ?? DEFAULT_NR_SETTINGS.intensity),
        preset: Number(option(args, "--preset") ?? DEFAULT_NR_SETTINGS.preset) as 0 | 1 | 2 | 3,
        localTone: Number(option(args, "--local-tone") ?? DEFAULT_NR_SETTINGS.localTone),
        localStructure: Number(option(args, "--local-structure") ?? DEFAULT_NR_SETTINGS.localStructure),
      };
      const session = openGpu({ adapterIndex: option(args, "--adapter") !== undefined ? Number(option(args, "--adapter")) : undefined });
      const started = performance.now();
      const nr = DlssNrSession.open(session, {
        width: image.width,
        height: image.height,
        settings,
        runtimeDir: option(args, "--runtime") ?? join(ROOT, "runtime"),
      });
      const rgba = nr.evaluate(image.rgba, true);
      await Bun.write(output, encodePng({ width: image.width, height: image.height, rgba }, { level: 6 }));
      nr.close();
      console.log(`DLSS NR: ${image.width}x${image.height} enhanced (intensity ${settings.intensity}, preset ${settings.preset}) in ${(performance.now() - started).toFixed(1)} ms`);
      console.log(`wrote ${output}`);
      process.exit(0);
    }
    case "versions": {
      const catalog = buildRuntimeCatalog(option(args, "--runtime") ?? join(ROOT, "runtime"));
      for (const feature of catalog.features) {
        console.log(`feature ${feature.id}  ${feature.name}  (${feature.dllName})  ${feature.versions.length} version(s)`);
        for (const v of feature.versions) {
          console.log(`  ${v.version.padEnd(14)} ${v.source.padEnd(10)} ${String(v.sizeMB).padStart(7)} MB  ${v.dir}`);
        }
      }
      return;
    }
    default:
      console.log("usage: bun run src/cli.ts <probe|forwarder|sr|nr|versions> [options]");
      process.exit(command ? 1 : 0);
  }
}

await main();
