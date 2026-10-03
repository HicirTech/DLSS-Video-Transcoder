/* The `?mock=1` backend: answers every API call in the browser from mock data and the in-memory job engine. */
import type { ApiClient, JobEventSource } from "../api";
import { ApiError } from "../errors";
import { validateJobRequest } from "../../../src/server/validate";
import { MOCK_PROBE, MOCK_TOOLS, mockCatalog, mockSettingsDefaults, mockUpload } from "./fixtures";
import { MockJobEngine, timestamp } from "./job-engine";
import { mockPreviewSvg } from "./preview-svg";
import { createSeedJobs } from "./seed-jobs";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Browser-side replacement for the HTTP client + WebSocket feed, driven by MockJobEngine timers. */
export function createMockBackend(): { client: ApiClient; events: JobEventSource } {
  const engine = new MockJobEngine(createSeedJobs());
  const client: ApiClient = {
    probe: async () => {
      await delay(1200);
      return { ...structuredClone(MOCK_PROBE), generatedAt: timestamp() };
    },
    runtime: async () => structuredClone(MOCK_PROBE.runtime),
    settingsDefaults: async () => mockSettingsDefaults(),
    tools: async () => structuredClone(MOCK_TOOLS),
    catalog: async () => mockCatalog(),
    listJobs: async () => engine.list(),
    getJob: async (id) => {
      const job = engine.get(id);
      if (!job) throw new ApiError(404, `No job with id ${id}`);
      return job;
    },
    createJob: async (request) => {
      const invalid = validateJobRequest(request);
      if (invalid) throw new ApiError(400, invalid);
      await delay(200);
      return engine.create(request);
    },
    cancelJob: async (id) => {
      const job = engine.cancel(id);
      if (!job) throw new ApiError(404, `No job with id ${id}`);
      return job;
    },
    uploadFile: async (file) => {
      await delay(150);
      return mockUpload(file);
    },
    fileUrl: (path) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mockPreviewSvg(path))}`,
  };
  const events: JobEventSource = {
    connect({ onEvent, onConnection }) {
      onConnection(true);
      onEvent({ type: "hello", serverTime: timestamp() });
      const unsubscribe = engine.subscribe(onEvent);
      return () => {
        unsubscribe();
        onConnection(false);
      };
    },
  };
  return { client, events };
}
