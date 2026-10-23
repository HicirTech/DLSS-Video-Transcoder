/** Display formatting the panels share: file names, rates, durations, times, sizes, hex ids and a job's elapsed time. */
import { ratToNumber, tryParseRate } from "../../src/pipeline/rational";
import { isActiveState, type JobStatus } from "../../src/server/api-types";

/** Last path segment, accepting both Windows and POSIX separators. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}

/** The file name without its last extension, as the server's default output name keeps it ("clip.mp4" -> "clip"). */
export function stemOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** An ffmpeg rate ("30000/1001", "25") as frames per second, or null when it is not one. */
export function rateValue(text: string): number | null {
  const rate = tryParseRate(text);
  return rate ? ratToNumber(rate) : null;
}

/** Frames per second with at most three decimals and no trailing zeros: 29.97, 23.976, 60. */
export function formatFps(fps: number): string {
  return String(Number(fps.toFixed(3)));
}

/** Duration such as "0.8 s", "1m 23s" or "2h 05m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  // Round to whole seconds first, then pick the unit, so a value that rounds up
  // to 60 shows as "1m 00s" rather than "60 s" (and 3600 as "1h 00m").
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "-" when the timestamp is missing, the input itself when it does not parse, otherwise the rendered date. */
function formatTimestamp(iso: string | null, render: (date: Date) => string): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : render(date);
}

/** Wall-clock time in the browser's locale; "-" when the timestamp is missing, the input itself when it does not parse. */
export function formatTime(iso: string | null): string {
  return formatTimestamp(iso, (date) => date.toLocaleTimeString());
}

/** Date and time in the browser's locale; "-" when the timestamp is missing, the input itself when it does not parse. */
export function formatDateTime(iso: string | null): string {
  return formatTimestamp(iso, (date) => date.toLocaleString());
}

/** "-" when null, one decimal below 10 MB, whole MB up to 1024, GB with one decimal above. */
export function formatMB(mb: number | null): string {
  if (mb === null) return "-";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** Zero-padded upper-case hex with a 0x prefix, e.g. 0x10DE. */
export function formatHex(value: number, width = 4): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

/** Milliseconds the job has been running (or ran), null before it starts. */
export function jobElapsedMs(job: JobStatus, now: number): number | null {
  if (!job.startedAt) return null;
  const start = new Date(job.startedAt).getTime();
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

export function isJobActive(job: JobStatus): boolean {
  return isActiveState(job.state);
}

export function sortJobsNewestFirst(jobs: JobStatus[]): JobStatus[] {
  return jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
