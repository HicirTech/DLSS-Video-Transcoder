/** The browser's transport to the server: the ApiClient over HTTP and the /ws job event source, or their ?mock=1 stand-ins. */
import {
  type JobRequest,
  type JobStatus,
  type MediaInfo,
  type ProbeReport,
  type SettingsDefaults,
  type ToolsReport,
  type UploadResult,
  type WsEvent,
} from "../../src/server/api-types";
import type { RuntimeManifest } from "../../src/ngx/runtime-catalog";
import { ApiError, errorMessage } from "./errors";
import { isRecord } from "./json";
import { createMockBackend } from "./mock/backend";

/** One method per endpoint in src/server/api-types.ts. */
export interface ApiClient {
  probe(): Promise<ProbeReport>;
  runtime(): Promise<ProbeReport["runtime"]>;
  settingsDefaults(): Promise<SettingsDefaults>;
  tools(): Promise<ToolsReport>;
  /** The installed DLSS runtime DLLs per feature (for version selection). */
  catalog(): Promise<RuntimeManifest>;
  listJobs(): Promise<JobStatus[]>;
  getJob(id: string): Promise<JobStatus>;
  createJob(request: JobRequest): Promise<JobStatus>;
  cancelJob(id: string): Promise<JobStatus>;
  /** Uploads a browser file to the server; resolves to the saved absolute path to use as a job input. */
  uploadFile(file: File): Promise<UploadResult>;
  /** What a job would read from the file at `path`: its size, and a video's rates, length, codec and audio. */
  media(path: string): Promise<MediaInfo>;
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
    throw new Error(
      bodyErrorMessage(text) ??
        `${init?.method ?? "GET"} ${path} failed with ${response.status} ${response.statusText} and no message. Check the server console, then try again.`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `The server sent an unreadable response (invalid JSON) from ${path}. The page and the server may be different versions: reload the page, and restart the server if it keeps happening.`,
    );
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
    catalog: () => request<RuntimeManifest>("/api/catalog"),
    listJobs: () => request<JobStatus[]>("/api/jobs"),
    getJob: (id) => request<JobStatus>(`/api/jobs/${encodeURIComponent(id)}`),
    createJob: (body) => request<JobStatus>("/api/jobs", postJson(body)),
    cancelJob: (id) => request<JobStatus>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    uploadFile: (file) => request<UploadResult>(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file }),
    media: (path) => request<MediaInfo>(`/api/media?path=${encodeURIComponent(path)}`),
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
/** The /ws job event feed, or the mock backend's simulation of it. */
export const jobEvents: JobEventSource = mockBackend ? mockBackend.events : createWebSocketSource();
