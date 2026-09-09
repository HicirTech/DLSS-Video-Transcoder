/**
 * Neural Render server: serves the React UI and the JSON API documented in
 * api-types.ts. Start with `bun run src/server/main.ts` (PORT overrides 4080;
 * 3080 is inside a Windows reserved port range on some machines).
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
const UPLOADS_DIR = join(APP_DATA, "uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isJobRequest(value: unknown): value is JobRequest {
  if (!isObject(value)) return false;
  const v = value;
  return (
    (v.kind === "image" || v.kind === "video") &&
    typeof v.input === "string" &&
    (v.output === undefined || typeof v.output === "string") &&
    (v.engine === "bypass" || v.engine === "nr" || v.engine === "sr") &&
    (v.motion === "none" || v.motion === "flow") &&
    isObject(v.settings) &&
    isObject(v.scale) &&
    (v.frameGen === undefined ||
      (isObject(v.frameGen) &&
        // One of targetFps / multiplier must be present, or the job has no rate to aim for.
        (typeof v.frameGen.multiplier === "number" || typeof v.frameGen.targetFps === "string") &&
        (v.frameGen.multiplier === undefined || typeof v.frameGen.multiplier === "number") &&
        (v.frameGen.targetFps === undefined || typeof v.frameGen.targetFps === "string") &&
        (v.frameGen.engine === undefined || v.frameGen.engine === "auto" || v.frameGen.engine === "native" || v.frameGen.engine === "cascade")))
  );
}

/** True if `child` resolves to a path inside `root` (used to confine job output paths). */
function isWithin(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Bind to loopback by default: this API has no auth and exposes file read
// (/api/file) and job output paths, so it must not be network-reachable unless
// the operator explicitly opts in with NR_HOST.
const HOST = process.env.NR_HOST ?? "127.0.0.1";

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
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
          return fail("Request body must be valid JSON.");
        }
        if (!isJobRequest(body))
          return fail(
            "Invalid job request. Expected kind ('image' or 'video'), an absolute input path, engine ('sr', 'nr' or 'bypass'), motion ('none' or 'flow'), and settings and scale objects.",
          );
        if (!isAbsolute(body.input) || !existsSync(body.input))
          return fail(`Input file not found: ${body.input}. Provide an absolute path to a file that exists.`);
        // Confine the output path so a request cannot write anywhere on the host.
        if (body.output !== undefined) {
          const roots = [APP_DATA, RUNTIME_DIR, dirname(resolve(body.input))];
          if (!isAbsolute(body.output) || !roots.some((r) => isWithin(body.output!, r)))
            return fail("The output path must be absolute and inside the app-data folder or the input's own directory.");
        }
        return json(jobs.submit(body), 201);
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
    "/api/file": (req) => {
      // Serves any local file for preview, because user-selected inputs and job outputs
      // live wherever the user chose. Safe only because the server binds loopback (see
      // HOST) — NR_HOST must not reach a public interface without auth in front of it.
      const path = new URL(req.url).searchParams.get("path") ?? "";
      if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile())
        return fail("File not found. The 'path' query parameter must be an absolute path to an existing file.", 404);
      const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
      return new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": "no-store" } });
    },
    "/api/upload": {
      // Stores a browser upload and returns its absolute path for use as a job input.
      // The stored name is generated, never taken from the client, so an upload cannot
      // escape UPLOADS_DIR via a traversing filename.
      POST: async (req) => {
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          return fail("Upload must be multipart/form-data with a 'file' field.");
        }
        const file = form.get("file");
        if (!(file instanceof File)) return fail("Upload is missing the 'file' field.");
        const ext = extname(file.name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
        const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const dest = join(UPLOADS_DIR, name);
        await Bun.write(dest, file);
        return json({ path: dest, name: file.name, size: file.size }, 201);
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
  appDataPath: APP_DATA,
  broadcast: (event) => {
    server.publish("jobs", JSON.stringify(event));
  },
});

console.log(`Neural Render server listening on http://localhost:${server.port}  (runtime: ${RUNTIME_DIR})`);
