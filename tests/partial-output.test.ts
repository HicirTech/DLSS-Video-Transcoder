/**
 * Who owns the file at a run's output path after a failure or a cancellation
 * (src/pipeline/partial-output.ts, which states the rule and why).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunFailedError, framesWrittenOf, removePartialOutput } from "../src/pipeline/partial-output.ts";

describe("removePartialOutput", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "partial-output-"));
    dirs.push(dir);
    const path = join(dir, "out.mp4");
    writeFileSync(path, "partial");
    return path;
  };

  test("a run that wrote no frame keeps a file that was already there", () => {
    const path = tempFile();
    removePartialOutput(path, 0, true);
    expect(existsSync(path)).toBe(true);
  });

  test("a run that wrote frames deletes the file, however it started", () => {
    for (const [framesWritten, outputExisted] of [[1, true], [14936, true], [1, false]] as const) {
      const path = tempFile();
      removePartialOutput(path, framesWritten, outputExisted);
      expect(existsSync(path)).toBe(false);
    }
  });

  test("with nothing there before, the path is the run's own to clean up", () => {
    const path = tempFile();
    removePartialOutput(path, 0, false);
    expect(existsSync(path)).toBe(false);
  });

  test("an owned path with nothing at it is not an error", () => {
    const path = join(tempFile(), "..", "never-created.mp4");
    expect(() => removePartialOutput(path, 3, false)).not.toThrow();
  });
});

describe("framesWrittenOf", () => {
  test("reads the count from any record of it and is 0 for anything else", () => {
    expect(framesWrittenOf(new RunFailedError("ffmpeg died", 12))).toBe(12);
    expect(framesWrittenOf({ framesWritten: 5 })).toBe(5);
    expect(framesWrittenOf(new Error("plain"))).toBe(0);
    expect(framesWrittenOf(null)).toBe(0);
  });
});
