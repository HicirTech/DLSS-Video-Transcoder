/** Renders a probe report as the human summary the `probe` command prints. */
import type { runProbe } from "../ngx/probe.ts";
import type { ProbeAdapter, ProbeOpticalFlow } from "../server/api-types.ts";

/**
 * One line on the hardware optical-flow engine. The limits are the engine's own
 * input range; the pipeline never feeds it a source frame, only a grid between
 * pipelineGrid.minSide and pipelineGrid.maxLongSide a side, so the line says
 * whether that grid fits instead of leaving the reader to compare numbers.
 */
function opticalFlowLine(flow: ProbeOpticalFlow): string {
  const grid = flow.pipelineGrid;
  if (flow.status === "not queried") return `not queried — ${flow.detail}`;
  if (flow.status === "unavailable" || !flow.limits || !flow.outGridSizes) return `unavailable on CUDA device ${flow.cudaOrdinal} — ${flow.detail}`;
  const l = flow.limits;
  const fits = l.widthMin <= grid.minSide && l.heightMin <= grid.minSide && l.widthMax >= grid.maxLongSide && l.heightMax >= grid.maxLongSide;
  return `ok on CUDA device ${flow.cudaOrdinal}; input ${l.widthMin}..${l.widthMax} x ${l.heightMin}..${l.heightMax} px; output grids ${flow.outGridSizes.join(", ")}; the pipeline feeds it a ${grid.minSide}..${grid.maxLongSide} px grid, which ${fits ? "fits" : "does NOT fit"}`;
}

export function printProbe(report: Awaited<ReturnType<typeof runProbe>>): void {
  const lines: string[] = [];
  lines.push(`Neural Render probe  (${report.generatedAt})`);
  lines.push(`Bun ${report.platform.bun} on ${report.platform.os}`);
  lines.push("");
  lines.push("Adapters:");
  // "n/a" when CUDA could not be asked at all, so a driver problem does not read as "this adapter has no CUDA device".
  const cudaColumn = (a: ProbeAdapter): string => (report.cuda.error !== null ? "n/a" : a.cudaOrdinal === null ? "none" : `${a.cudaOrdinal}${a.cudaUuid ? ` (${a.cudaUuid})` : ""}`);
  for (const a of report.adapters) {
    const mark = a.index === report.selectedAdapter ? "*" : " ";
    lines.push(`  ${mark} [${a.index}] ${a.name}  vendor=0x${a.vendorId.toString(16)}  vram=${a.dedicatedVideoMemoryMB} MB  luid=${a.luid}  cudaDevice=${cudaColumn(a)}${a.software ? "  (software)" : ""}`);
  }
  lines.push(report.cuda.error === null ? `CUDA: ${report.cuda.deviceCount} device(s) listed by the driver` : `CUDA: not available — ${report.cuda.error}`);
  lines.push(`D3D12 device: ${report.device.created ? "created" : "FAILED"}${report.device.hresult && !report.device.created ? ` (${report.device.hresult})` : ""}`);
  lines.push(`Hardware optical flow (NVOFA): ${opticalFlowLine(report.opticalFlow)}`);
  lines.push(`Driver: ${report.driver.version ?? "unknown"}`);
  // The core's own file version, which is not the number nvidia-smi reports for
  // the same driver (32.0.16.1664 vs 616.64), so both are shown.
  const coreVersion = report.driver.ngxCoreVersion ? `  v${report.driver.ngxCoreVersion}` : "";
  lines.push(`NGX core: ${report.driver.ngxCorePath ?? "not found"}${coreVersion}${report.driver.ngxCoreExports.length ? `  (${report.driver.ngxCoreExports.length} exports)` : ""}`);
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
    const version = f.version ? `  v${f.version}` : "";
    lines.push(`  ${f.present ? "present" : "missing"}  ${f.name.padEnd(18)} ${f.role}${version}${f.sizeMB !== null ? `  ${f.sizeMB} MB` : ""}${f.exports ? `  ${f.exports.length} exports` : ""}`);
  }
  lines.push(`Forwarder: ${report.forwarder.selfTest ?? "not built"}`);
  lines.push("");
  lines.push(`Neural rendering ready: ${report.verdict.neuralRenderingReady ? "YES" : "NO"}`);
  for (const r of report.verdict.reasons) lines.push(`  - ${r}`);
  console.log(lines.join("\n"));
}
