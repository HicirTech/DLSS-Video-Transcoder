import type { JobStatus } from "../../src/server/api-types";

/** Last path segment, accepting both Windows and POSIX separators. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
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

/** Wall-clock time in the browser's locale, or "-" when the timestamp is missing. */
export function formatTime(iso: string | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
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
  return job.state === "queued" || job.state === "running";
}

export function sortJobsNewestFirst(jobs: JobStatus[]): JobStatus[] {
  return jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
