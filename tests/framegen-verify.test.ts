/**
 * The read-back check of a frame-generation output (src/pipeline/framegen-verify.ts): an output it cannot read back
 * is deleted like one with the wrong timeline, so a failed job never leaves a file that looks like a success. No GPU.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyOutputVideo } from "../src/pipeline/framegen-verify.ts";
import { rational } from "../src/pipeline/rational.ts";

describe("verifyOutputVideo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("an output ffprobe cannot read back is deleted, and the error says so and what to do", () => {
    const dir = mkdtempSync(join(tmpdir(), "framegen-verify-"));
    dirs.push(dir);
    const output = join(dir, "out.mp4");
    writeFileSync(output, "muxed");
    const missingFfprobe = join(dir, "no-such-ffprobe.exe");
    expect(() => verifyOutputVideo(missingFfprobe, output, rational(60), 600)).toThrow(/The file was removed, since its timeline could not be checked; run the job again\.$/);
    expect(existsSync(output)).toBe(false);
  });
});
