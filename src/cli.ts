/**
 * Command line entry point.
 *
 *   bun run src/cli.ts probe [--json] [--adapter N] [--runtime DIR] [--project-init] [--debug-layer]
 *   bun run src/cli.ts forwarder [--out PATH]
 */
import { join } from "node:path";
import { buildForwarderDll } from "./ngx/forwarder.ts";
import { runProbe } from "./ngx/probe.ts";

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
    default:
      console.log("usage: bun run src/cli.ts <probe|forwarder> [options]");
      process.exit(command ? 1 : 0);
  }
}

await main();
