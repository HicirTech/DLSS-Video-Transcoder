/**
 * What GET /api/media reads before a job runs: a PNG's size from its header alone (readPngHeader, mediaInfo).
 * A video's probe needs ffprobe, so it is checked on the real server instead. No GPU.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG_HEADER_BYTES, readPngHeader } from "../src/codec/png/chunks.ts";
import { encodePng } from "../src/codec/png/encode.ts";
import { PngError } from "../src/codec/png/types.ts";
import { mediaInfo } from "../src/server/media-info.ts";
import { randomImage } from "./png-reference.ts";

const folder = mkdtempSync(join(tmpdir(), "media-info-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("readPngHeader", () => {
  const png = encodePng(randomImage(37, 21, 1));

  test("sizes an image from its first PNG_HEADER_BYTES alone", () => {
    expect(readPngHeader(png.subarray(0, PNG_HEADER_BYTES))).toMatchObject({ width: 37, height: 21 });
  });

  test("refuses what is not a PNG, and a header cut short", () => {
    expect(() => readPngHeader(new TextEncoder().encode("GIF89a, not a PNG at all, padded"))).toThrow(PngError);
    expect(() => readPngHeader(png.subarray(0, PNG_HEADER_BYTES - 1))).toThrow(/truncated/);
  });
});

describe("mediaInfo", () => {
  test("a PNG is an image of its header's size, read without ffprobe", async () => {
    const path = join(folder, "still.png");
    writeFileSync(path, encodePng(randomImage(64, 48, 2)));
    expect(await mediaInfo(path)).toEqual({ kind: "image", width: 64, height: 48 });
  });
});
