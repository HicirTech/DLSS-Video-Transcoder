/**
 * Command line entry point.
 *
 * Commands: probe | forwarder | sr | nr | fg | versions | help
 * Run `bun run src/cli.ts help` for the overview or `help <command>` for details.
 * The command specs in COMMANDS below are the single source of truth for that help.
 */
import { basename, dirname, extname, join } from "node:path";
import { decodePng, encodePng, isPng } from "./codec/png.ts";
import { buildForwarderDll } from "./ngx/forwarder.ts";
import { runProbe } from "./ngx/probe.ts";
import { DlssNrSession } from "./ngx/nr-render.ts";
import { buildRuntimeCatalog } from "./ngx/runtime-catalog.ts";
import { DlssSrSession } from "./ngx/sr.ts";
import { DEFAULT_NR_SETTINGS, type EncodeSettings } from "./server/api-types.ts";
import { DlssRenderPreset, DLSS_RATIO } from "./ngx/results.ts";
import { processFrameGen } from "./pipeline/framegen.ts";
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

/** Flag names that consume a following value token, derived from a command spec ("--factor N" does, "--json" does not). */
function valueFlagNames(spec: CommandSpec): Set<string> {
  const s = new Set<string>();
  for (const o of spec.options) {
    const [name, ...rest] = o.flag.split(/\s+/);
    if (rest.length && name) s.add(name);
  }
  return s;
}

/**
 * Positional arguments only: skip every `--flag` and, for value-bearing flags,
 * the value token that follows it. Without this a value like `3` in
 * `sr in.png --factor 3` (which does not start with `--`) would be mistaken for
 * the optional output path.
 */
function positionalArgs(args: string[], spec: CommandSpec): string[] {
  const valued = valueFlagNames(spec);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (valued.has(a)) i++; // skip this flag's value token
      continue;
    }
    out.push(a);
  }
  return out;
}

interface OptionSpec {
  /** As typed on the command line, e.g. "--factor N" or "--json". */
  readonly flag: string;
  readonly desc: string;
  readonly def?: string;
}

interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly args?: readonly { readonly name: string; readonly desc: string }[];
  readonly options: readonly OptionSpec[];
  readonly notes?: readonly string[];
}

const RUNTIME_OPT: OptionSpec = { flag: "--runtime DIR", desc: "runtime folder holding the NGX DLLs / workers", def: "<repo>/runtime" };
const ADAPTER_OPT: OptionSpec = { flag: "--adapter N", desc: "GPU adapter index (from `probe`)", def: "auto" };

const COMMANDS: readonly CommandSpec[] = [
  {
    name: "probe",
    summary: "Inspect the GPU, driver, NGX core and runtime folder; report which DLSS features are ready.",
    usage: "bun run src/cli.ts probe [options]",
    options: [
      { flag: "--json", desc: "print the full report as JSON instead of the human summary" },
      { flag: "--log", desc: "append the internal probe log lines to the output" },
      ADAPTER_OPT,
      RUNTIME_OPT,
      { flag: "--entry loader|core", desc: "NGX entry point to initialise through", def: "core" },
      { flag: "--init ext|plain|spy", desc: "which NGX Init variant to call", def: "ext" },
      { flag: "--project-init", desc: "use the project-scoped Init (app id + project path) instead of the app Init" },
      { flag: "--null-feature-info", desc: "pass a null FeatureCommonInfo to Init (diagnostic)" },
      { flag: "--no-requirements", desc: "skip the per-feature GetFeatureRequirements queries" },
      { flag: "--debug-layer", desc: "enable the D3D12 debug layer (needs the Graphics Tools installed)" },
    ],
  },
  {
    name: "forwarder",
    summary: "Generate the x64 `nvngx.dll` shim that makes NGX accept our in-process calls (caller-module check).",
    usage: "bun run src/cli.ts forwarder [--out PATH]",
    options: [
      { flag: "--out PATH", desc: "where to write the generated shim DLL", def: "<repo>/runtime/caller/nvngx.dll" },
    ],
    notes: ["Only needed to (re)build the shim by hand; sr/nr build it automatically when missing."],
  },
  {
    name: "sr",
    summary: "DLSS Super Resolution (NGX feature 1): real upscaling of a single PNG. This is the only true upscaler.",
    usage: "bun run src/cli.ts sr <input.png> [output.png] [options]",
    args: [
      { name: "input.png", desc: "source image (PNG only)" },
      { name: "output.png", desc: "destination; defaults to <input>.dlss.png next to the input" },
    ],
    options: [
      { flag: "--factor N", desc: "upscale factor, snapped to the nearest fixed DLSS mode: 1.0=DLAA, 1.3=UltraQuality, 1.5=Quality, 1.72=Balanced, 2.0=Performance, 3.0=UltraPerformance", def: "2" },
      { flag: "--preset NAME", desc: "render preset: Default, A-F (older CNN models) or J-O (transformer models)", def: "L" },
      { flag: "--dlss-version VER", desc: "use a specific installed SR DLL version (prefix match ok); list them with `versions`", def: "bundled runtime DLL" },
      RUNTIME_OPT,
      ADAPTER_OPT,
    ],
  },
  {
    name: "nr",
    summary: "DLSS Neural Rendering / 'DLSS 5' (NGX feature 18): enhance a single PNG at the same size (no upscale).",
    usage: "bun run src/cli.ts nr <input.png> [output.png] [options]",
    args: [
      { name: "input.png", desc: "source image (PNG only)" },
      { name: "output.png", desc: "destination; defaults to <input>.nr.png next to the input" },
    ],
    options: [
      { flag: "--intensity F", desc: "overall strength, 0..2 (1 = default; effect tends to plateau past ~1)", def: String(DEFAULT_NR_SETTINGS.intensity) },
      { flag: "--style N", desc: "look style: 0 = Default, 1 = Natural, 2 = Cinematic (strong, visible effect)", def: String(DEFAULT_NR_SETTINGS.style) },
      { flag: "--preset ID", desc: "NR model preset hint: 0 = Default, 1/2/3 = Preset #1/#2/#3 (experimental, content-dependent)", def: String(DEFAULT_NR_SETTINGS.preset) },
      { flag: "--local-tone F", desc: "local tone-mapping strength (float); typical 0..2, 1 = neutral", def: String(DEFAULT_NR_SETTINGS.localTone) },
      { flag: "--local-structure F", desc: "local detail / structure strength (float); typical 0..2, 1 = neutral", def: String(DEFAULT_NR_SETTINGS.localStructure) },
      { flag: "--skin-structure F", desc: "detail strength on skin regions only; -1 = runtime default, typical 0..2", def: String(DEFAULT_NR_SETTINGS.skinStructure) },
      { flag: "--auto-mask", desc: "let the runtime derive the processed-region mask instead of the whole frame", def: "off" },
      { flag: "--ui-correction", desc: "protect overlays / text / sharp UI edges from being re-rendered", def: "off" },
      RUNTIME_OPT,
      ADAPTER_OPT,
    ],
  },
  {
    name: "fg",
    summary: "DLSS Frame Generation (NGX feature 11): interpolate a video to a higher frame rate via dlssg-worker.exe.",
    usage: "bun run src/cli.ts fg <input.mp4> [output.mp4] [options]",
    args: [
      { name: "input.mp4", desc: "source video (any format ffmpeg can decode)" },
      { name: "output.mp4", desc: "destination; defaults to <input>.dlssg.mp4 next to the input" },
    ],
    options: [
      { flag: "--multiplier N", desc: "output/input frame ratio (2 = double fps); 2x reliable, up to GPU max", def: "2" },
      { flag: "--codec NAME", desc: "encoder: h264, hevc, av1, or h264_nvenc/hevc_nvenc/av1_nvenc for GPU", def: "GPU NVENC when available, else libx264" },
      { flag: "--quality N", desc: "encoder quality (CRF for CPU, CQ for NVENC), 0..51 (lower = better)", def: "20" },
      RUNTIME_OPT,
    ],
  },
  {
    name: "versions",
    summary: "List every DLSS runtime DLL found (per feature), with its version, source and folder.",
    usage: "bun run src/cli.ts versions [--runtime DIR]",
    options: [RUNTIME_OPT],
    notes: ["Use a listed SR version string with `sr --dlss-version`."],
  },
  {
    name: "help",
    summary: "Show this overview, or detailed help for one command.",
    usage: "bun run src/cli.ts help [command]",
    options: [],
  },
];

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
  lines.push("common options (accepted where relevant):");
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

function printHelp(command?: string): boolean {
  if (command) {
    const spec = COMMANDS.find((c) => c.name === command);
    if (!spec) {
      console.error(`unknown command '${command}'. Run 'bun run src/cli.ts help' for the list.`);
      return false;
    }
    printCommandHelp(spec);
    return true;
  }
  printOverview();
  return true;
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
  // Global help: `help`, `--help`/`-h` with no command, or no command at all.
  if (command === "help") {
    const ok = printHelp(args.filter((a) => !a.startsWith("-"))[0]);
    process.exit(ok ? 0 : 1);
  }
  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }
  // Per-command help: `<command> --help` / `-h`.
  if (flag(args, "--help") || flag(args, "-h")) {
    const ok = printHelp(command);
    process.exit(ok ? 0 : 1);
  }
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
      const positional = positionalArgs(args, COMMANDS.find((c) => c.name === command)!);
      const input = positional[0];
      if (!input) {
        console.error("error: missing <input.png>\n");
        printHelp("sr");
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
      // Case-insensitive preset lookup so documented values like "Default" work
      // (the key is mixed-case "Default", not "DEFAULT"); reject unknown presets
      // instead of silently falling back to L.
      const presetInput = option(args, "--preset") ?? "L";
      const presetKey = (Object.keys(DlssRenderPreset) as (keyof typeof DlssRenderPreset)[]).find((k) => k.toLowerCase() === presetInput.toLowerCase());
      if (!presetKey) {
        console.error(`error: unknown --preset '${presetInput}'. Valid: ${Object.keys(DlssRenderPreset).join(", ")}`);
        process.exit(1);
      }
      const preset = DlssRenderPreset[presetKey];
      // Snap the output size to the chosen DLSS mode's fixed ratio (help documents
      // --factor as snapping to a mode); feeding DLSS a render/output ratio that
      // does not match its PerfQuality mode risks CreateFeature failure/artifacts.
      const snappedRatio = DLSS_RATIO[quality] ?? factor;
      const outputWidth = evenSize(image.width * snappedRatio);
      const outputHeight = evenSize(image.height * snappedRatio);
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
      console.log(`DLSS SR: ${image.width}x${image.height} -> ${outputWidth}x${outputHeight} (quality ${quality}, preset ${presetKey}) in ${(performance.now() - started).toFixed(1)} ms`);
      console.log(`wrote ${output}`);
      // The driver core's Shutdown1 is skipped; exit the process to reclaim NGX.
      process.exit(0);
    }
    case "nr": {
      const positional = positionalArgs(args, COMMANDS.find((c) => c.name === command)!);
      const input = positional[0];
      if (!input) {
        console.error("error: missing <input.png>\n");
        printHelp("nr");
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
        style: Number(option(args, "--style") ?? DEFAULT_NR_SETTINGS.style) as 0 | 1 | 2,
        preset: Number(option(args, "--preset") ?? DEFAULT_NR_SETTINGS.preset) as 0 | 1 | 2 | 3,
        localTone: Number(option(args, "--local-tone") ?? DEFAULT_NR_SETTINGS.localTone),
        localStructure: Number(option(args, "--local-structure") ?? DEFAULT_NR_SETTINGS.localStructure),
        skinStructure: Number(option(args, "--skin-structure") ?? DEFAULT_NR_SETTINGS.skinStructure),
        autoMask: flag(args, "--auto-mask") || DEFAULT_NR_SETTINGS.autoMask,
        uiCorrection: flag(args, "--ui-correction") || DEFAULT_NR_SETTINGS.uiCorrection,
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
    case "fg": {
      const positional = positionalArgs(args, COMMANDS.find((c) => c.name === command)!);
      const input = positional[0];
      if (!input) {
        console.error("error: missing <input.mp4>\n");
        printHelp("fg");
        process.exit(1);
      }
      const result = await processFrameGen({
        input,
        output: positional[1],
        multiplier: Number(option(args, "--multiplier") ?? 2),
        quality: Number(option(args, "--quality") ?? 20),
        codec: option(args, "--codec") as EncodeSettings["codec"] | undefined,
        runtimeDir: option(args, "--runtime") ?? join(ROOT, "runtime"),
        onProgress: (f, m, frames) => {
          if (frames === undefined) console.log(`  ${(f * 100).toFixed(0)}%  ${m}`);
        },
      });
      console.log(`DLSS Frame Generation: ${result.inputFrames} -> ${result.outputFrames} frames, ${result.sourceFps.toFixed(2)} -> ${result.outputFps.toFixed(2)} fps in ${result.ms} ms`);
      console.log(`wrote ${result.output}`);
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
      console.error(`unknown command '${command}'.`);
      console.error("");
      printHelp();
      process.exit(1);
  }
}

await main();
