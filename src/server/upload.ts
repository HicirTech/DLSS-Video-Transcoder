/**
 * POST /api/upload: the request body is the file's bytes and ?name= its name. The body streams straight to a
 * new file in the uploads folder, so an upload of any size takes constant memory (5 GiB peaked at 45 MiB on
 * Bun 1.4.2, where parsing the same upload as multipart form data needed twice its size and failed at 5 GiB).
 */
import { extname, join } from "node:path";
import { removePartialOutput } from "../pipeline/partial-output.ts";
import type { UploadResult } from "./api-types.ts";

/**
 * Bun.serve's request-body limit for a server that takes uploads: none in practice, since the body streams to
 * disk. Bun's default, 128 MiB, refuses most videos with a bare 413 and a reset connection.
 */
export const MAX_REQUEST_BODY_BYTES = Number.MAX_SAFE_INTEGER;

export type UploadOutcome = { ok: true; upload: UploadResult } | { ok: false; status: number; error: string };

/** The client's file name from ?name=, or why the request cannot be stored. */
export function uploadFileName(request: Request): { name: string } | { error: string } {
  const name = new URL(request.url).searchParams.get("name");
  return name ? { name } : { error: "Upload needs the file's name as ?name=<file name> and the file's bytes as the request body." };
}

/**
 * Where an upload is stored: a generated name, never the client's, so a traversing name cannot leave the
 * folder; only the client name's extension is kept, cleaned.
 */
function storedPath(folder: string, clientName: string): string {
  const extension = extname(clientName).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
  return join(folder, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${extension}`);
}

/** Store one upload in `folder`; a transfer that breaks off leaves no partial file behind. */
export async function storeUpload(request: Request, folder: string): Promise<UploadOutcome> {
  const named = uploadFileName(request);
  if ("error" in named) return { ok: false, status: 400, error: named.error };
  const path = storedPath(folder, named.name);
  try {
    const size = await Bun.write(path, request);
    return { ok: true, upload: { path, name: named.name, size } };
  } catch (error) {
    // The stored name is new, so the failed upload owns whatever part of the file was written.
    removePartialOutput(path, 0, false);
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 500,
      error: `The upload stopped before the whole file was stored (${reason}); nothing was kept. Upload it again, or type the file's path on the machine that runs the server.`,
    };
  }
}
