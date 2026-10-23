/** The live job list: fetched from /api/jobs, then kept current from the job event feed. */
import { useCallback, useEffect, useRef, useState } from "react";
import { type JobStatus, trimJobLog, type WsEvent } from "../../../src/server/api-types";
import { api, jobEvents } from "../api";
import { errorMessage } from "../errors";

/** Merges one WsEvent into a job list, returning a new array when something changed. */
function applyWsEvent(jobs: JobStatus[], event: WsEvent): JobStatus[] {
  switch (event.type) {
    case "hello":
      return jobs;
    case "job": {
      const index = jobs.findIndex((job) => job.id === event.job.id);
      if (index < 0) return [...jobs, event.job];
      const next = jobs.slice();
      next[index] = event.job;
      return next;
    }
    case "log": {
      const index = jobs.findIndex((job) => job.id === event.jobId);
      if (index < 0) return jobs;
      const job = jobs[index];
      const log = [...job.log, event.line];
      trimJobLog(log);
      const next = jobs.slice();
      next[index] = { ...job, log };
      return next;
    }
  }
}

/** Where the job list stands. Each failure is a new object, so an effect keyed on it runs again for a repeated one. */
export type JobsFeedStatus = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; error: string };

export interface JobsFeed {
  jobs: JobStatus[];
  /** True while the /ws socket is open (always true in mock mode). */
  connected: boolean;
  /** How the last GET /api/jobs went; a failure keeps the jobs already listed. */
  status: JobsFeedStatus;
  refresh(): Promise<void>;
}

/** Fetches /api/jobs, then keeps the list current from the /ws feed (resyncing after every reconnect). */
export function useJobsFeed(): JobsFeed {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<JobsFeedStatus>({ kind: "loading" });
  // Only the newest refresh applies its answer. The server can serialise that snapshot before a job event that
  // reaches the page first, so the job events received while the refresh is in flight are replayed onto it.
  const refreshGeneration = useRef(0);
  const pendingJobEvents = useRef<WsEvent[] | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++refreshGeneration.current;
    pendingJobEvents.current = [];
    try {
      const list = await api.listJobs();
      if (generation !== refreshGeneration.current) return;
      const received = pendingJobEvents.current ?? [];
      pendingJobEvents.current = null;
      setJobs(received.reduce(applyWsEvent, list));
      setStatus({ kind: "ready" });
    } catch (err) {
      if (generation !== refreshGeneration.current) return;
      // The list on screen already holds those events, and a failed refresh leaves it as it is.
      pendingJobEvents.current = null;
      setStatus({ kind: "failed", error: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refresh();
    const stop = jobEvents.connect({
      onEvent: (event) => {
        if (!active) return;
        setJobs((current) => applyWsEvent(current, event));
        // Log lines are not replayed: the snapshot holds every line sent before it, so a replay would repeat some.
        if (event.type === "job") pendingJobEvents.current?.push(event);
      },
      onConnection: (isConnected) => {
        if (!active) return;
        setConnected(isConnected);
        if (isConnected) void refresh();
      },
    });
    return () => {
      active = false;
      stop();
    };
  }, [refresh]);

  return { jobs, connected, status, refresh };
}
