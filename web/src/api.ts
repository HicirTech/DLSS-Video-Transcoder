import { useCallback, useEffect, useState } from "react";
import type {
  EncodeSettings,
  JobRequest,
  JobStatus,
  NrSettings,
  ProbeReport,
  ScaleSettings,
  ToolsReport,
  WsEvent,
} from "../../src/server/api-types";
import { ApiError, errorMessage } from "./errors";
import { createMockBackend } from "./mock";

/** Response shape of GET /api/settings/defaults. */
export interface SettingsDefaults {
  settings: NrSettings;
  scale: ScaleSettings;
  encode: EncodeSettings;
}

/** One method per endpoint in src/server/api-types.ts. */
export interface ApiClient {
  probe(): Promise<ProbeReport>;
  runtime(): Promise<ProbeReport["runtime"]>;
  settingsDefaults(): Promise<SettingsDefaults>;
  tools(): Promise<ToolsReport>;
  listJobs(): Promise<JobStatus[]>;
  getJob(id: string): Promise<JobStatus>;
  createJob(request: JobRequest): Promise<JobStatus>;
  cancelJob(id: string): Promise<JobStatus>;
  /** Uploads a browser file to the server; resolves to the saved absolute path to use as a job input. */
  uploadFile(file: File): Promise<{ path: string; name: string; size: number }>;
  /** URL that serves the raw bytes of a local file (input / output previews). */
  fileUrl(path: string): string;
}

export interface JobEventHandlers {
  onEvent(event: WsEvent): void;
  onConnection(connected: boolean): void;
}

/** Delivers WsEvents: the /ws socket in normal mode, a timer-driven simulation in mock mode. */
export interface JobEventSource {
  /** Starts the feed and returns a function that stops it. */
  connect(handlers: JobEventHandlers): () => void;
}

/** True when the page was opened with `?mock=1`; the client then never touches the network. */
export function isMockMode(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("mock") === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJobStatus(value: unknown): value is JobStatus {
  return isRecord(value) && typeof value.id === "string" && typeof value.state === "string" && Array.isArray(value.log);
}

/** Validates a raw WebSocket frame; unknown or malformed messages yield null. */
export function parseWsEvent(raw: unknown): WsEvent | null {
  if (typeof raw !== "string") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  switch (data.type) {
    case "hello":
      return typeof data.serverTime === "string" ? { type: "hello", serverTime: data.serverTime } : null;
    case "job":
      return isJobStatus(data.job) ? { type: "job", job: data.job } : null;
    case "log":
      return typeof data.jobId === "string" && typeof data.line === "string"
        ? { type: "log", jobId: data.jobId, line: data.line }
        : null;
    default:
      return null;
  }
}

/** Pulls a readable message out of an error body: `{ error }`, `{ message }` or plain text. */
function bodyErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // not JSON: use the text itself
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, `Cannot reach the server. Check that it is still running, then try again: ${errorMessage(err)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, bodyErrorMessage(text) ?? `${response.status} ${response.statusText}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, `The server sent an unreadable response (invalid JSON) from ${path}`);
  }
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function createHttpClient(): ApiClient {
  return {
    probe: () => request<ProbeReport>("/api/probe"),
    runtime: () => request<ProbeReport["runtime"]>("/api/runtime"),
    settingsDefaults: () => request<SettingsDefaults>("/api/settings/defaults"),
    tools: () => request<ToolsReport>("/api/tools"),
    listJobs: () => request<JobStatus[]>("/api/jobs"),
    getJob: (id) => request<JobStatus>(`/api/jobs/${encodeURIComponent(id)}`),
    createJob: (body) => request<JobStatus>("/api/jobs", postJson(body)),
    cancelJob: (id) => request<JobStatus>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    uploadFile: (file) => {
      const form = new FormData();
      form.append("file", file);
      return request<{ path: string; name: string; size: number }>("/api/upload", { method: "POST", body: form });
    },
    fileUrl: (path) => `/api/file?path=${encodeURIComponent(path)}`,
  };
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/** Same-origin /ws socket that reconnects with exponential backoff (1 s to 15 s, with jitter). */
function createWebSocketSource(): JobEventSource {
  return {
    connect({ onEvent, onConnection }) {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const url = `${scheme}://${location.host}/ws`;
      let socket: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let attempts = 0;
      let stopped = false;

      const scheduleReconnect = (): void => {
        if (stopped) return;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts) + Math.random() * 250;
        attempts += 1;
        timer = setTimeout(open, delay);
      };

      const open = (): void => {
        if (stopped) return;
        const ws = new WebSocket(url);
        socket = ws;
        ws.onopen = () => {
          attempts = 0;
          onConnection(true);
        };
        ws.onmessage = (message: MessageEvent<unknown>) => {
          const event = parseWsEvent(message.data);
          if (event) onEvent(event);
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = null;
          onConnection(false);
          scheduleReconnect();
        };
      };

      open();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        const ws = socket;
        socket = null;
        ws?.close();
      };
    },
  };
}

const mockBackend = isMockMode() ? createMockBackend() : null;

/** The API client used by the whole UI (mock-backed when the page URL has `?mock=1`). */
export const api: ApiClient = mockBackend ? mockBackend.client : createHttpClient();
const jobEvents: JobEventSource = mockBackend ? mockBackend.events : createWebSocketSource();

/** Lines kept per job when the server streams `log` events. */
export const MAX_LOG_LINES = 400;

/** Merges one WsEvent into a job list, returning a new array when something changed. */
export function applyWsEvent(jobs: JobStatus[], event: WsEvent): JobStatus[] {
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
      if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
      const next = jobs.slice();
      next[index] = { ...job, log };
      return next;
    }
  }
}

export interface JobsFeed {
  jobs: JobStatus[];
  /** True while the /ws socket is open (always true in mock mode). */
  connected: boolean;
  /** Last error from fetching /api/jobs, cleared by the next successful fetch. */
  error: string | null;
  refresh(): Promise<void>;
}

/** Fetches /api/jobs, then keeps the list current from the /ws feed (resyncing after every reconnect). */
export function useJobsFeed(): JobsFeed {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listJobs();
      setJobs(list);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refresh();
    const stop = jobEvents.connect({
      onEvent: (event) => {
        if (active) setJobs((current) => applyWsEvent(current, event));
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

  return { jobs, connected, error, refresh };
}
