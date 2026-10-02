/**
 * Manual GPU diagnostic (not part of `bun test`): does DlssgFeature generate N frames per interval,
 * earliest first and at k/(N+1) of the interval, with the installed nvngx_dlssg.dll, for N = 1..5?
 *
 * A 64x64 white square moves 8 px per source frame with exact backward motion vectors. Source
 * frame 6 is a hard cut, the square jumping to another row and column, sent with Reset as the
 * guide worker sends it: the reset interval must read back as an honoured reset and the interval
 * after it must generate in full. Each N runs in its own process under a hard timeout: NGX is
 * initialised once per process and never shut down (core.ts). `--generated N` runs that one N in
 * this process instead.
 *
 *   bun run tests/diag-dlssg.ts [--runtime-dir <folder with nvngx_dlssg.dll>] [--caller-dir <folder>]
 *                               [--generated N] [--dump <folder for i<frame>-k<index>.rgba>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersionInfo } from "../src/native/version-info.ts";
import {
  DlssgFeature,
  DlssgFeatureStaleError,
  DlssgResetIgnoredError,
  DlssgUnavailableError,
  type DlssgCapabilities,
  type DlssgIntervalInput,
  type DlssgIntervalResult,
} from "../src/ngx/dlssg-feature.ts";
import { CALLER_DIR, RUNTIME_DIR } from "../src/paths.ts";
import { encodeMotionR16G16 } from "../src/pipeline/flow.ts";
import { openGpu } from "../src/pipeline/gpu.ts";

const WIDTH = 1280;
const HEIGHT = 720;
const SQUARE_SIDE = 64;
const STEP_PIXELS = 8;
const SOURCE_FRAMES = 12;
const CUT_FRAME = 6;
/** Where the square starts before and after the cut; the cut moves it to another row and column. */
const SHOTS = [
  { firstFrame: 0, firstLeft: 64, top: 328 },
  { firstFrame: CUT_FRAME, firstLeft: 640, top: 128 },
];
const GENERATED_COUNTS = [1, 2, 3, 4, 5];
const CHILD_TIMEOUT_MS = 120_000;
// The square's rows plus this margin, for anything the model smears above or below it.
const CENTROID_ROW_MARGIN = 28;

interface SquarePlacement {
  left: number;
  top: number;
}

interface IntervalReport {
  frame: number;
  reset: boolean;
  outcome: string;
  frames: number;
  phases: number[];
  failures: string[];
}

interface GeneratedCountReport {
  generatedCount: number;
  runtimeVersion: string | null;
  capabilities: DlssgCapabilities | null;
  refused: string | null;
  maxPhaseError: number | null;
  intervals: IntervalReport[];
  pass: boolean;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
}

const runtimeDir = option("--runtime-dir", join(RUNTIME_DIR, "dlssg"));
const callerDir = option("--caller-dir", CALLER_DIR);
const dumpDir = option("--dump", "");

/**
 * Measured with the flat plane depth on nvngx_dlssg.dll 310.9.1: N <= 3 stays within 0.034 of
 * k/(N+1), while at N = 4 and 5 the middle frames lag by up to 0.11 (0.9 px at 8 px per frame),
 * a limit of constant depth rather than of the index loop.
 */
function phaseTolerance(generatedCount: number): number {
  return generatedCount <= 3 ? 0.05 : 0.12;
}

const isShotStart = (frame: number): boolean => SHOTS.some((shot) => shot.firstFrame === frame);

function squarePlacement(frame: number): SquarePlacement {
  const shot = SHOTS.findLast((candidate) => candidate.firstFrame <= frame)!;
  return { left: shot.firstLeft + (frame - shot.firstFrame) * STEP_PIXELS, top: shot.top };
}

function squareFrame(frame: number): Uint8Array {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let alpha = 3; alpha < rgba.length; alpha += 4) rgba[alpha] = 255;
  const { left, top } = squarePlacement(frame);
  for (let y = top; y < top + SQUARE_SIDE; y++) rgba.fill(255, (y * WIDTH + left) * 4, (y * WIDTH + left + SQUARE_SIDE) * 4);
  return rgba;
}

/**
 * Backward (current to previous) pixels: the square's current footprint came from STEP_PIXELS to
 * the left, on a shot's first frame too. The guide worker sends zero motion with a reset instead;
 * measured on 310.9.1 that puts the first interval after the reset off k/(N+1) by up to 0.15 at
 * N >= 2, so this check keeps the shot's own motion there.
 */
function squareMotion(frame: number): Uint8Array {
  const motion = new Float32Array(WIDTH * HEIGHT * 2);
  const { left, top } = squarePlacement(frame);
  for (let y = top; y < top + SQUARE_SIDE; y++) {
    for (let x = left; x < left + SQUARE_SIDE; x++) motion[(y * WIDTH + x) * 2] = -STEP_PIXELS;
  }
  const half = encodeMotionR16G16(motion);
  return new Uint8Array(half.buffer, half.byteOffset, half.byteLength);
}

/** Red-weighted x centroid over the rows of the square's shot, sub-pixel exact for a soft-edged square. */
function centroidX(rgba: Uint8Array, squareTop: number): number {
  let weighted = 0;
  let total = 0;
  for (let y = squareTop - CENTROID_ROW_MARGIN; y < squareTop + SQUARE_SIDE + CENTROID_ROW_MARGIN; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const red = rgba[(y * WIDTH + x) * 4]!;
      weighted += x * red;
      total += red;
    }
  }
  return total === 0 ? Number.NaN : weighted / total;
}

interface CentroidSpan {
  previous: number;
  current: number;
  squareTop: number;
}

function checkInterval(report: IntervalReport, generatedCount: number, result: DlssgIntervalResult, span: CentroidSpan): void {
  if (report.reset) {
    if (result.outcome !== "reset") report.failures.push(`reset interval came back ${result.outcome}, expected an honoured reset`);
    return;
  }
  if (result.outcome !== "generated" || result.frames.length !== generatedCount) {
    report.failures.push(`expected ${generatedCount} generated frames, got ${result.outcome} with ${report.frames}`);
    return;
  }
  report.phases = result.frames.map((frame) => (centroidX(frame, span.squareTop) - span.previous) / (span.current - span.previous));
  report.phases.forEach((phase, index) => {
    const expected = (index + 1) / (generatedCount + 1);
    if (!(Math.abs(phase - expected) <= phaseTolerance(generatedCount))) report.failures.push(`k=${index + 1} phase ${phase.toFixed(3)}, expected ${expected.toFixed(3)} +/- ${phaseTolerance(generatedCount)}`);
    if (index > 0 && !(phase > report.phases[index - 1]!)) report.failures.push(`k=${index + 1} is not later than k=${index}`);
  });
}

function runtimeVersion(): string | null {
  try {
    return parseVersionInfo(readFileSync(join(runtimeDir, "nvngx_dlssg.dll"))).fileVersion;
  } catch {
    return null;
  }
}

function dumpFrames(frame: number, generated: Uint8Array[]): void {
  if (!dumpDir) return;
  mkdirSync(dumpDir, { recursive: true });
  generated.forEach((rgba, index) => writeFileSync(join(dumpDir, `i${frame}-k${index + 1}.rgba`), rgba));
}

/** The interval's result, or null when the driver refused to go on; the refusal is then the report's failure. */
function evaluateInterval(feature: DlssgFeature, input: DlssgIntervalInput, report: IntervalReport): DlssgIntervalResult | null {
  try {
    const result = feature.interval(input);
    report.outcome = result.outcome;
    report.frames = result.outcome === "generated" ? result.frames.length : 0;
    return result;
  } catch (error) {
    if (!(error instanceof DlssgFeatureStaleError || error instanceof DlssgResetIgnoredError)) throw error;
    report.outcome = error.name;
    report.failures.push(error.message);
    return null;
  }
}

function runIntervals(feature: DlssgFeature, generatedCount: number): IntervalReport[] {
  const intervals: IntervalReport[] = [];
  let previousCentroid = Number.NaN;
  for (let frame = 0; frame < SOURCE_FRAMES; frame++) {
    const rgba = squareFrame(frame);
    const squareTop = squarePlacement(frame).top;
    const currentCentroid = centroidX(rgba, squareTop);
    const input: DlssgIntervalInput = { rgba, motion: squareMotion(frame), reset: isShotStart(frame), frameId: frame, generatedCount };
    const report: IntervalReport = { frame, reset: input.reset, outcome: "", frames: 0, phases: [], failures: [] };
    intervals.push(report);
    const result = evaluateInterval(feature, input, report);
    if (!result) break;
    checkInterval(report, generatedCount, result, { previous: previousCentroid, current: currentCentroid, squareTop });
    if (result.outcome === "generated") dumpFrames(frame, result.frames);
    previousCentroid = currentCentroid;
  }
  return intervals;
}

function runOneGeneratedCount(generatedCount: number): GeneratedCountReport {
  const report: GeneratedCountReport = { generatedCount, runtimeVersion: runtimeVersion(), capabilities: null, refused: null, maxPhaseError: null, intervals: [], pass: false };
  const session = openGpu({});
  let feature: DlssgFeature | null = null;
  try {
    feature = DlssgFeature.open(session, { width: WIDTH, height: HEIGHT, maxGenerated: generatedCount, runtimeDir, callerDir });
    report.capabilities = feature.capabilities;
    report.intervals = runIntervals(feature, generatedCount);
  } catch (error) {
    if (!(error instanceof DlssgUnavailableError)) throw error;
    report.capabilities = error.capabilities;
    report.refused = `${error.reason}: ${error.message}`;
  } finally {
    feature?.close();
    session.close();
  }
  const errors = report.intervals.flatMap((interval) => interval.phases.map((phase, index) => Math.abs(phase - (index + 1) / (generatedCount + 1))));
  report.maxPhaseError = errors.length ? Math.max(...errors) : null;
  report.pass = report.refused === null && report.intervals.length === SOURCE_FRAMES && report.intervals.every((interval) => interval.failures.length === 0);
  return report;
}

async function spawnGeneratedCount(generatedCount: number): Promise<GeneratedCountReport | string> {
  const args = [process.execPath, import.meta.path, "--generated", String(generatedCount), "--runtime-dir", runtimeDir, "--caller-dir", callerDir];
  if (dumpDir) args.push("--dump", join(dumpDir, `n${generatedCount}`));
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, CHILD_TIMEOUT_MS);
  try {
    const [text, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (timedOut) return `killed after ${CHILD_TIMEOUT_MS / 1000} s`;
    const line = text.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
    return line ? (JSON.parse(line) as GeneratedCountReport) : `exited ${exitCode} without a report`;
  } finally {
    clearTimeout(timer);
  }
}

function printReport(report: GeneratedCountReport): void {
  const maximum = report.capabilities ? report.capabilities.multiFrameCountMax : "?";
  console.log(`N=${report.generatedCount} (${report.generatedCount + 1}x) ${report.pass ? "PASS" : "FAIL"}  nvngx_dlssg ${report.runtimeVersion ?? "?"}  MultiFrameCountMax ${maximum}  max phase error ${report.maxPhaseError?.toFixed(3) ?? "-"}`);
  if (report.refused) console.log(`    refused: ${report.refused}`);
  for (const interval of report.intervals) {
    const phases = interval.phases.map((phase) => phase.toFixed(3)).join(" ");
    console.log(`    frame ${String(interval.frame).padStart(2)}${interval.reset ? " reset" : "      "} ${interval.outcome.padEnd(9)} ${interval.frames} frame(s) ${phases}`);
    for (const failure of interval.failures) console.log(`      FAIL ${failure}`);
  }
}

const requested = option("--generated", "");
if (requested) {
  const report = runOneGeneratedCount(Number(requested));
  printReport(report);
  console.log(JSON.stringify(report));
  process.exit(report.pass ? 0 : 1);
}

console.log(`runtime ${runtimeDir}, caller shim ${callerDir}`);
let allPass = true;
for (const generatedCount of GENERATED_COUNTS) {
  const report = await spawnGeneratedCount(generatedCount);
  if (typeof report === "string") {
    console.log(`N=${generatedCount} (${generatedCount + 1}x) FAIL  ${report}`);
    allPass = false;
    continue;
  }
  printReport(report);
  allPass &&= report.pass;
}
console.log(allPass ? "OK" : "FAILED");
process.exit(allPass ? 0 : 1);
