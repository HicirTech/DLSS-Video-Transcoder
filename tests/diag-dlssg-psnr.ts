/**
 * Manual GPU diagnostic (not part of `bun test`): the quality gate for native multi-frame generation
 * through the DLSS Frame Generation host. W:/GPUVideoProcessor/2.mp4 is decimated so that only
 * every (N+1)th frame is fed to dlssg-host.ts over the real protocol (DlssgSession), with the
 * motion and scene cuts the frame-generation guide worker computes (NVOFA optical flow on CUDA
 * device FRAMEGEN_CUDA_DEVICE),
 * and every generated frame is scored by RGB PSNR against the real frame it stands in for. Frames
 * are streamed from ffmpeg and dropped once scored.
 *
 * Fails when an interval other than a reset comes back empty (generation disabled) or with a frame
 * count other than N. At N = 3 (4x) it also fails when the median PSNR is below 38.73 dB, what a
 * cascade of 2x stages scored on the same clip at 4x (issue #93); other N get scores, no PSNR verdict.
 *
 *   bun run tests/diag-dlssg-psnr.ts [--input <video>] [--generated N (3 = 4x)] [--kept-frames K (0 = whole clip)]
 */
import { featureDir, RUNTIME_DIR } from "../src/paths.ts";
import { DlssgSession } from "../src/pipeline/dlssg.ts";
import { HOST_PROCESS_NAME } from "../src/pipeline/dlssg-host-launch.ts";
import { createMotionEstimator } from "../src/pipeline/flow.ts";
import { FrameReader } from "../src/pipeline/frame-reader.ts";
import { FRAMEGEN_CUDA_DEVICE } from "../src/pipeline/framegen-plan.ts";
import { tryCreateNvofBackend } from "../src/pipeline/nvof.ts";
import { parseRational, ratDiv, rational } from "../src/pipeline/rational.ts";
import { findTool } from "../src/pipeline/tools.ts";
import { probeVideo } from "../src/pipeline/video-probe.ts";

/** Median PSNR of 2x cascade stages on 2.mp4 decimated x4 (issue #93), the bar native 4x must reach. */
const CASCADE_MEDIAN_DB = 38.73;
/** The generated count CASCADE_MEDIAN_DB was measured for: 3 per interval, 4x. */
const CASCADE_BAR_GENERATED = 3;
const CLOSE_TIMEOUT_MS = 5_000;

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
}

const input = option("--input", "W:/GPUVideoProcessor/2.mp4");
const generatedCount = Number(option("--generated", String(CASCADE_BAR_GENERATED)));
const keptFrameLimit = Number(option("--kept-frames", "0"));
const sourceStep = generatedCount + 1;

/** RGB PSNR in dB of two RGBA8 frames of one size; alpha is ignored. Infinity when they are identical. */
function psnr(generated: Uint8Array, real: Uint8Array): number {
  let squaredError = 0;
  for (let offset = 0; offset < real.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = generated[offset + channel]! - real[offset + channel]!;
      squaredError += difference * difference;
    }
  }
  const meanSquaredError = squaredError / ((real.length / 4) * 3);
  return meanSquaredError === 0 ? Infinity : 10 * Math.log10((255 * 255) / meanSquaredError);
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

const ffmpeg = findTool("ffmpeg");
const ffprobe = findTool("ffprobe");
if (!ffmpeg || !ffprobe) throw new Error("ffmpeg and ffprobe are required (install with `winget install Gyan.FFmpeg` or set FFMPEG_PATH / FFPROBE_PATH).");
const info = probeVideo(ffprobe, input, ffmpeg);
const { width, height } = info;
const frameBytes = width * height * 4;
// The nominal CFR clock, the one framegen.ts stamps source frames in.
const sourceRate = parseRational(info.nominalFpsText);

const scores: number[] = [];
const counts = { kept: 0, generatedIntervals: 0, emptyIntervals: 0, mismatchedIntervals: 0, sceneCuts: 0, bestMatchInPlace: 0 };
const started = performance.now();
let failure: string | null = null;
let opticalFlow = "not started";
const decoder = Bun.spawn([ffmpeg, "-v", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { stdout: "pipe", stderr: "inherit" });
let estimator: ReturnType<typeof createMotionEstimator> | null = null;
let session: DlssgSession | null = null;
try {
  const reader = new FrameReader(decoder.stdout);
  const nvof = tryCreateNvofBackend(width, height, FRAMEGEN_CUDA_DEVICE);
  opticalFlow = nvof.backend ? "NVOFA" : `CPU (${nvof.reason})`;
  estimator = createMotionEstimator(width, height, nvof.backend ? { backend: nvof.backend } : {});
  const zeroMotion = new Uint16Array(width * height * 2);
  session = await DlssgSession.open(RUNTIME_DIR, { width, height, generatedCount });
  let dropped: Uint8Array[] = [];
  for (let sourceIndex = 0; keptFrameLimit === 0 || counts.kept < keptFrameLimit; sourceIndex++) {
    const frame = await reader.next(frameBytes);
    if (!frame) break;
    if (sourceIndex % sourceStep !== 0) {
      dropped.push(frame);
      continue;
    }
    const first = counts.kept === 0;
    const motion = estimator.processPacked(frame, false);
    // The first stage's guide worker: a detected cut starts a new history, as does the first frame.
    const reset = first || motion.reset;
    if (!first && motion.reset) counts.sceneCuts++;
    const timestamp = ratDiv(rational(sourceIndex), sourceRate);
    const generated = await session.processFrame(frame, motion.half ?? zeroMotion, counts.kept, reset, timestamp.num, timestamp.den);
    counts.kept++;
    if (generated.length === 0) {
      if (!first) counts.emptyIntervals++;
    } else if (generated.length !== dropped.length) {
      counts.mismatchedIntervals++;
    } else {
      counts.generatedIntervals++;
      generated.forEach((image, position) => {
        const againstEach = dropped.map((real) => psnr(image, real));
        scores.push(againstEach[position]!);
        if (Math.max(...againstEach) === againstEach[position]) counts.bestMatchInPlace++;
      });
    }
    dropped = [];
  }
} catch (error) {
  failure = (error as Error).message;
} finally {
  decoder.kill();
  estimator?.close();
  await session?.close(CLOSE_TIMEOUT_MS);
}

const seconds = (performance.now() - started) / 1000;
const sorted = [...scores].sort((a, b) => a - b);
const median = sorted.length ? percentile(sorted, 0.5) : Number.NaN;
// A reset interval (a scene cut) is empty by design; any other empty one had generation disabled.
const disabledIntervals = Math.max(0, counts.emptyIntervals - counts.sceneCuts);
console.log(`${input} kept every ${sourceStep}th frame: ${counts.kept} kept, native ${sourceStep}x on ${HOST_PROCESS_NAME} (${featureDir(RUNTIME_DIR, "fg")}), optical flow ${opticalFlow}, ${seconds.toFixed(1)} s`);
console.log(`intervals: ${counts.generatedIntervals} generated, ${counts.emptyIntervals} empty after the first (${disabledIntervals} beyond the scene cuts), ${counts.mismatchedIntervals} with a frame count other than ${generatedCount}, ${counts.sceneCuts} scene cut(s)`);
if (sorted.length) {
  console.log(`PSNR of ${sorted.length} generated frames against the dropped real frames: median ${median.toFixed(2)} dB, mean ${(scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(2)}, 5th percentile ${percentile(sorted, 0.05).toFixed(2)}, min ${sorted[0]!.toFixed(2)}, max ${sorted.at(-1)!.toFixed(2)}`);
  console.log(`frames closest to the real frame they stand in for: ${counts.bestMatchInPlace} of ${sorted.length}`);
}

const problems: string[] = [];
if (failure) problems.push(failure);
if (!sorted.length) problems.push("no generated frame was scored");
if (disabledIntervals > 0) problems.push(`${disabledIntervals} interval(s) came back empty without a scene cut (generation disabled)`);
if (counts.mismatchedIntervals > 0) problems.push(`${counts.mismatchedIntervals} interval(s) returned a frame count other than ${generatedCount}`);
const judgedByPsnr = generatedCount === CASCADE_BAR_GENERATED;
if (judgedByPsnr && sorted.length && !(median >= CASCADE_MEDIAN_DB)) problems.push(`median ${median.toFixed(2)} dB is below the cascade's ${CASCADE_MEDIAN_DB} dB`);
if (problems.length) {
  console.log(`FAIL: ${problems.join("; ")}`);
} else {
  console.log(
    judgedByPsnr
      ? `PASS: median ${median.toFixed(2)} dB >= ${CASCADE_MEDIAN_DB} dB (the cascade's at 4x)`
      : `PASS: every interval generated ${generatedCount} frame(s); no PSNR verdict, as the ${CASCADE_MEDIAN_DB} dB bar was measured at 4x only`,
  );
}
process.exit(problems.length ? 1 : 0);
