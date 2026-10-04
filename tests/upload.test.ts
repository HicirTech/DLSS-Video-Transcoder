/**
 * storeUpload (src/server/upload.ts): POST /api/upload streams the request body to a generated file in
 * the uploads folder, named by ?name=, and leaves nothing behind when the body breaks off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { storeUpload } from "../src/server/upload.ts";

const folders: string[] = [];

function uploadsFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "upload-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function uploadRequest(query: string, body: BodyInit | null): Request {
  return new Request(`http://127.0.0.1/api/upload${query}`, { method: "POST", body });
}

describe("storeUpload", () => {
  test("stores the body's bytes under a generated name that keeps the extension", async () => {
    const folder = uploadsFolder();
    const bytes = new Uint8Array(300_000).map((_, index) => index % 251);
    const outcome = await storeUpload(uploadRequest("?name=clip%20one.MP4", bytes), folder);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.upload.name).toBe("clip one.MP4");
    expect(outcome.upload.size).toBe(bytes.length);
    expect(dirname(outcome.upload.path)).toBe(folder);
    expect(outcome.upload.path.endsWith(".mp4")).toBe(true);
    expect(new Uint8Array(readFileSync(outcome.upload.path))).toEqual(bytes);
  });

  test("a traversing name cannot leave the uploads folder", async () => {
    const folder = uploadsFolder();
    const outcome = await storeUpload(uploadRequest(`?name=${encodeURIComponent("..\\..\\evil.mp4")}`, new Uint8Array(16)), folder);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(dirname(outcome.upload.path)).toBe(folder);
    expect(outcome.upload.name).toBe("..\\..\\evil.mp4");
  });

  test("a request without ?name= is refused and stores nothing", async () => {
    const folder = uploadsFolder();
    const outcome = await storeUpload(uploadRequest("", new Uint8Array(16)), folder);
    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: "Upload needs the file's name as ?name=<file name> and the file's bytes as the request body.",
    });
    expect(readdirSync(folder)).toEqual([]);
  });

  test("a body that breaks off midway leaves no partial file and says what to do", async () => {
    const folder = uploadsFolder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array(65_536));
        else controller.error(new Error("The connection was closed."));
      },
    });
    const outcome = await storeUpload(uploadRequest("?name=cut.mp4", body), folder);
    if (outcome.ok) throw new Error("a broken body was stored");
    expect(outcome.status).toBe(500);
    expect(outcome.error).toContain("nothing was kept. Upload it again, or type the file's path");
    expect(readdirSync(folder)).toEqual([]);
  });
});
