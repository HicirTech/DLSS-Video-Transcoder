/*
 * Standalone preview server: serves the UI from index.html and answers every /api route and
 * /ws with mock data, so the frontend can be developed without the real backend. Opening the
 * page with `?mock=1` instead keeps the same requests inside the browser (src/mock.ts).
 *
 * Listens on 127.0.0.1:3080; PORT=3090 moves it. On Windows a failed bind is usually a
 * Hyper-V / WSL port reservation: `netsh interface ipv4 show excludedportrange protocol=tcp`.
 */
import index from "./index.html";
import type { JobRequest, WsEvent } from "../src/server/api-types";
import { DEFAULT_ENCODE_SETTINGS, DEFAULT_NR_SETTINGS, DEFAULT_SCALE_SETTINGS } from "../src/server/api-types";
import { ApiError } from "./src/errors";
import {
  MOCK_PROBE,
  MOCK_TOOLS,
  MockJobEngine,
  createSeedJobs,
  isJobRequest,
  mockCatalog,
  mockPreviewSvg,
  mockSettingsDefaults,
  mockUpload,
  validateJobRequest,
} from "./src/mock";

const PORT = Number(process.env.PORT ?? "3080");
const JOBS_TOPIC = "jobs";
const FEEDER_INTERVAL_MS = 30_000;

const engine = new MockJobEngine(createSeedJobs());

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function failure(status: number, message: string): Response {
  return json({ error: message }, status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = Bun.serve({
  port: PORT,
  development: true,
  routes: {
    "/": index,
    "/api/probe": async () => {
      await sleep(1500);
      return json({ ...MOCK_PROBE, generatedAt: new Date().toISOString() });
    },
    "/api/runtime": () => json(MOCK_PROBE.runtime),
    "/api/catalog": () => json(mockCatalog()),
    "/api/upload": {
      POST: async (req) => {
        const form = await req.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return failure(400, "Upload is missing the 'file' field.");
        return json(mockUpload(file), 201);
      },
    },
    "/api/settings/defaults": () => json(mockSettingsDefaults()),
    "/api/tools": () => json(MOCK_TOOLS),
    "/api/jobs": {
      GET: () => json(engine.list()),
      POST: async (req) => {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return failure(400, "request body must be JSON");
        }
        if (!isJobRequest(body)) return failure(400, "request body is not a JobRequest");
        try {
          validateJobRequest(body);
        } catch (err) {
          if (err instanceof ApiError) return failure(err.status, err.message);
          throw err;
        }
        return json(engine.create(body), 201);
      },
    },
    "/api/jobs/:id": (req) => {
      const job = engine.get(req.params.id);
      return job ? json(job) : failure(404, `no job with id ${req.params.id}`);
    },
    "/api/jobs/:id/cancel": {
      POST: (req) => {
        const job = engine.cancel(req.params.id);
        return job ? json(job) : failure(404, `no job with id ${req.params.id}`);
      },
    },
    "/api/file": (req) => {
      const path = new URL(req.url).searchParams.get("path");
      if (!path) return failure(400, "the path query parameter is required");
      return new Response(mockPreviewSvg(path), {
        headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
      });
    },
    "/ws": (req, bunServer) => {
      if (bunServer.upgrade(req)) return undefined;
      return failure(400, "expected a WebSocket upgrade");
    },
  },
  fetch: () => failure(404, "not found"),
  websocket: {
    open(ws) {
      ws.subscribe(JOBS_TOPIC);
      const hello: WsEvent = { type: "hello", serverTime: new Date().toISOString() };
      ws.send(JSON.stringify(hello));
    },
    message() {
      // the client never sends anything
    },
    close(ws) {
      ws.unsubscribe(JOBS_TOPIC);
    },
  },
});

engine.subscribe((event) => {
  server.publish(JOBS_TOPIC, JSON.stringify(event));
});

/** Keeps the feed lively: queues a fake job now and then while little is running. */
const feeder = setInterval(() => {
  const active = engine.list().filter((job) => job.state === "queued" || job.state === "running").length;
  if (active >= 2) return;
  const serial = Math.floor(Math.random() * 900 + 100);
  const kind: JobRequest["kind"] = Math.random() < 0.5 ? "image" : "video";
  engine.create({
    kind,
    input: kind === "image" ? `C:\\Users\\tim\\Pictures\\IMG_${serial}.png` : `D:\\Footage\\clip-${serial}.mp4`,
    engine: "nr",
    motion: kind === "video" ? "flow" : "none",
    settings: { ...DEFAULT_NR_SETTINGS },
    scale: { ...DEFAULT_SCALE_SETTINGS },
    encode: { ...DEFAULT_ENCODE_SETTINGS },
  });
}, FEEDER_INTERVAL_MS);

function shutdown(): void {
  clearInterval(feeder);
  engine.dispose();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Neural Render mock server listening on http://127.0.0.1:${server.port}/ (append ?mock=1 for the in-browser mock)`);
