/**
 * Neural Render server: serves the React UI and the JSON API documented in
 * api-types.ts. Start with `bun run src/server/main.ts` (PORT overrides 4080;
 * 3080 is inside a Windows reserved port range on some machines).
 */
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import index from "../../web/index.html";
import { runProbe } from "../ngx/probe.ts";
import { buildRuntimeCatalog } from "../ngx/runtime-catalog.ts";
import { toolsReport } from "../pipeline/tools.ts";
import {
  DEFAULT_ENCODE_SETTINGS,
  DEFAULT_NR_SETTINGS,
  DEFAULT_SCALE_SETTINGS,
  type JobRequest,
  type WsEvent,
} from "./api-types.ts";
import { JobManager } from "./jobs.ts";

const ROOT = join(import.meta.dir, "..", "..");
const RUNTIME_DIR = process.env.NR_RUNTIME_DIR ?? join(ROOT, "runtime");
const APP_DATA = process.env.NR_APPDATA ?? join(ROOT, "logs");
const PORT = Number(process.env.PORT ?? 4080);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (message: string, status = 400): Response => json({ error: message }, status);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

function isJobRequest(value: unknown): value is JobRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "image" || v.kind === "video") &&
    typeof v.input === "string" &&
    (v.engine === "bypass" || v.engine === "nr") &&
    (v.motion === "none" || v.motion === "flow") &&
    typeof v.settings === "object" &&
    v.settings !== null &&
    typeof v.scale === "object" &&
    v.scale !== null
  );
}

const server = Bun.serve({
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/api/probe": async () => json(await runProbe({ runtimeDir: RUNTIME_DIR, appDataPath: APP_DATA })),
    "/api/runtime": async () => json((await runProbe({ runtimeDir: RUNTIME_DIR, appDataPath: APP_DATA, requirements: false })).runtime),
    "/api/tools": () => json(toolsReport()),
    "/api/catalog": () => json(buildRuntimeCatalog(RUNTIME_DIR)),
    "/api/settings/defaults": () => json({ settings: DEFAULT_NR_SETTINGS, scale: DEFAULT_SCALE_SETTINGS, encode: DEFAULT_ENCODE_SETTINGS }),
    "/api/jobs": {
      GET: () => json(jobs.list()),
      POST: async (req) => {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return fail("request body is not JSON");
        }
        if (!isJobRequest(body)) return fail("request body is not a JobRequest");
        if (!isAbsolute(body.input) || !existsSync(body.input)) return fail(`input does not exist: ${body.input}`);
        return json(jobs.submit(body), 201);
      },
    },
    "/api/jobs/:id": (req) => {
      const status = jobs.get(req.params.id);
      return status ? json(status) : fail("no such job", 404);
    },
    "/api/jobs/:id/cancel": {
      POST: (req) => {
        const status = jobs.cancel(req.params.id);
        return status ? json(status) : fail("no such job", 404);
      },
    },
    "/api/file": (req) => {
      const path = new URL(req.url).searchParams.get("path") ?? "";
      if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) return fail("file not found", 404);
      const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
      return new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": "no-store" } });
    },
    "/ws": (req, srv) => (srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 400 })),
  },
  fetch: () => new Response("not found", { status: 404 }),
  websocket: {
    open(ws) {
      ws.subscribe("jobs");
      const hello: WsEvent = { type: "hello", serverTime: new Date().toISOString() };
      ws.send(JSON.stringify(hello));
    },
    message() {},
    close(ws) {
      ws.unsubscribe("jobs");
    },
  },
});

const jobs = new JobManager({
  runtimeDir: RUNTIME_DIR,
  appDataPath: APP_DATA,
  broadcast: (event) => {
    server.publish("jobs", JSON.stringify(event));
  },
});

console.log(`Neural Render server listening on http://localhost:${server.port}  (runtime: ${RUNTIME_DIR})`);
