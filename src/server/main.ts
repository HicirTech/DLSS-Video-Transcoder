/**
 * Neural Render server: serves the React UI and the JSON API documented in
 * api-types.ts. Start with `bun run src/server/main.ts` (PORT overrides 4080;
 * 3080 is inside a Windows reserved port range on some machines).
 */
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import index from "../../web/index.html";
import { buildRuntimeCatalog } from "../ngx/runtime-catalog.ts";
import { runtimeReport } from "../ngx/runtime-inventory.ts";
import { APP_DATA_DIR, RUNTIME_DIR } from "../paths.ts";
import { toolsReport } from "../pipeline/tools.ts";
import { checkJobAdmission, isExistingFile } from "./admission.ts";
import { settingsDefaults, type WsEvent } from "./api-types.ts";
import { JobManager } from "./jobs.ts";
import { mediaInfo } from "./media-info.ts";
import { ProbeRunner } from "./probe-runner.ts";
import { MAX_REQUEST_BODY_BYTES, storeUpload } from "./upload.ts";
import { asJobRequest, validateJobRequest } from "./validate.ts";

const UPLOADS_DIR = join(APP_DATA_DIR, "uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });
const PORT = Number(process.env.PORT ?? 4080);

const probeRunner = new ProbeRunner();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (message: string, status = 400): Response => json({ error: message }, status);
/** The 404 of the two routes that read a file named in ?path=. */
const QUERY_FILE_NOT_FOUND = "File not found. The 'path' query parameter must be an absolute path to an existing file.";

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

// Bind to loopback by default: this API has no auth and exposes file read
// (/api/file) and job output paths, so it must not be network-reachable unless
// the operator explicitly opts in with NR_HOST.
const HOST = process.env.NR_HOST ?? "127.0.0.1";

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  development: process.env.NODE_ENV !== "production",
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  routes: {
    "/": index,
    "/api/probe": async () => {
      try {
        return json(await probeRunner.run());
      } catch (error) {
        return fail((error as Error).message, 500);
      }
    },
    "/api/runtime": async () => json(await runtimeReport(RUNTIME_DIR)),
    "/api/tools": async () => {
      try {
        return json(await toolsReport());
      } catch (error) {
        return fail((error as Error).message, 500);
      }
    },
    "/api/catalog": () => json(buildRuntimeCatalog(RUNTIME_DIR)),
    "/api/settings/defaults": () => json(settingsDefaults()),
    "/api/jobs": {
      GET: () => json(jobs.list()),
      POST: async (req) => {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return fail("Request body must be valid JSON.");
        }
        const invalid = validateJobRequest(body);
        if (invalid) return fail(invalid);
        const request = asJobRequest(body);
        const refusal = checkJobAdmission(request, { appDataDir: APP_DATA_DIR, loadCatalog: () => buildRuntimeCatalog(RUNTIME_DIR) });
        if (refusal) return fail(refusal);
        return json(jobs.submit(request), 201);
      },
    },
    "/api/jobs/:id": (req) => {
      const status = jobs.get(req.params.id);
      return status ? json(status) : fail("No job exists with that id.", 404);
    },
    "/api/jobs/:id/cancel": {
      POST: (req) => {
        const status = jobs.cancel(req.params.id);
        return status ? json(status) : fail("No job exists with that id.", 404);
      },
    },
    "/api/media": async (req) => {
      const path = new URL(req.url).searchParams.get("path") ?? "";
      if (!isExistingFile(path)) return fail(QUERY_FILE_NOT_FOUND, 404);
      try {
        return json(await mediaInfo(path));
      } catch (error) {
        return fail(`${path} could not be read as a PNG or a video: ${(error as Error).message}`);
      }
    },
    "/api/file": (req) => {
      // Serves any local file for preview, because user-selected inputs and job outputs
      // live wherever the user chose. Safe only because the server binds loopback (see
      // HOST) — NR_HOST must not reach a public interface without auth in front of it.
      const path = new URL(req.url).searchParams.get("path") ?? "";
      if (!isExistingFile(path)) return fail(QUERY_FILE_NOT_FOUND, 404);
      const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
      return new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": "no-store" } });
    },
    "/api/upload": {
      // Stores a browser upload and returns its absolute path for use as a job input.
      POST: async (req) => {
        const outcome = await storeUpload(req, UPLOADS_DIR);
        return outcome.ok ? json(outcome.upload, 201) : fail(outcome.error, outcome.status);
      },
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
  appDataPath: APP_DATA_DIR,
  broadcast: (event) => {
    server.publish("jobs", JSON.stringify(event));
  },
});

console.log(`Neural Render server listening on http://localhost:${server.port}  (runtime: ${RUNTIME_DIR})`);
