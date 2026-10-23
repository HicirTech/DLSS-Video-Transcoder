/**
 * Post-mux check for a frame-generation output: the file on disk must carry the
 * frame count and clock the plan promised. A worker that reports success can
 * still have written the wrong timeline, so the run is not finished until the
 * muxed file has been read back.
 */
import { unlinkSync } from "node:fs";
import { formatRational, parseRational, ratCmp, ratToNumber, type Rational, tryParseRate } from "./rational.ts";

/**
 * ffprobe's view of a written file. `frames` counts packets rather than trusting
 * a container header, `avgRate` is frames over container duration, and `rate` is
 * ffprobe's base rate (r_frame_rate), which verifyOutputVideo requires to equal
 * the target exactly.
 */
function probeOutputVideo(ffprobe: string, path: string): { frames: number; rate: Rational; avgRate: Rational; timeBase: string } {
  const proc = Bun.spawnSync([ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets,r_frame_rate,avg_frame_rate,time_base", "-of", "json", path], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`ffprobe could not verify the output: ${new TextDecoder().decode(proc.stderr).trim()}`);
  const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as { streams?: Array<{ nb_read_packets?: string; r_frame_rate?: string; avg_frame_rate?: string; time_base?: string }> };
  const stream = data.streams?.[0];
  if (!stream?.r_frame_rate) throw new Error("ffprobe found no video stream in the output.");
  const rate = parseRational(stream.r_frame_rate);
  return {
    frames: Number(stream.nb_read_packets ?? 0),
    rate,
    avgRate: tryParseRate(stream.avg_frame_rate) ?? rate,
    timeBase: stream.time_base ?? "?",
  };
}

/** Average rate is frames over container duration, so its final-frame rounding is allowed this relative drift (0.1 %). */
const AVERAGE_RATE_TOLERANCE = 1e-3;

/** Deletes an output that failed verification; the verification error is the one worth reporting, not an unlink's. */
function removeUnverifiedOutput(output: string): void {
  try {
    unlinkSync(output);
  } catch {
    /* the verification error is the one worth reporting */
  }
}

/**
 * Throw unless the muxed file matches the plan, deleting it first, also when it
 * cannot be read back: a file with a wrong or unknown timeline is worse than no
 * file, because it looks like a success.
 *
 * Packet count and base rate are exact — the track timescale is pinned to the
 * target rate's numerator and every frame lasts its denominator in ticks, so mp4
 * states the base rate as exactly the target (buildFrameGenEncodeArgs) — and
 * are compared strictly. The average rate only guards against a grossly wrong
 * timeline, within AVERAGE_RATE_TOLERANCE.
 */
export function verifyOutputVideo(
  ffprobe: string,
  output: string,
  targetRate: Rational,
  expectedFrames: number,
): void {
  let verified: ReturnType<typeof probeOutputVideo>;
  try {
    verified = probeOutputVideo(ffprobe, output);
  } catch (error) {
    removeUnverifiedOutput(output);
    throw new Error(`${(error as Error).message} The file was removed, since its timeline could not be checked; run the job again.`, { cause: error });
  }
  const averageOff = Math.abs(ratToNumber(verified.avgRate) / ratToNumber(targetRate) - 1);
  if (verified.frames === expectedFrames && ratCmp(verified.rate, targetRate) === 0 && averageOff <= AVERAGE_RATE_TOLERANCE) return;
  removeUnverifiedOutput(output);
  throw new Error(
    `Output verification found ${verified.frames} frames at base rate ${formatRational(verified.rate)} fps (average ${formatRational(verified.avgRate)}, time base ${verified.timeBase}); expected ${expectedFrames} at ${formatRational(targetRate)}. The file was removed. The encode wrote a different timeline than frame generation produced, a fault in this program rather than in the source: run the job again, and if it repeats, report it with these numbers.`,
  );
}
