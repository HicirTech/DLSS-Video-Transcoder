/**
 * A failed frame-generation run used to delete whatever file sat at its output
 * path, including a good result from a previous run of the same command — the
 * default name is `<input>.dlssg.mp4`, so re-running after success and hitting a
 * transient failure destroyed the earlier file.
 *
 * The encode ffmpeg is spawned with `-y` but reads from a pipe, so it does not
 * create or truncate the destination until the first frame reaches it. Whether
 * this run owns the file is therefore decided by whether it wrote a frame.
 */
import { describe, expect, test } from "bun:test";
import { failedRunOwnsOutput } from "../src/pipeline/framegen.ts";

describe("failedRunOwnsOutput", () => {
  test("a run that wrote no frame does not own a file that was already there", () => {
    expect(failedRunOwnsOutput(0, true)).toBe(false);
  });

  test("a run that wrote frames owns the file, however it started", () => {
    expect(failedRunOwnsOutput(1, true)).toBe(true);
    expect(failedRunOwnsOutput(14936, true)).toBe(true);
    expect(failedRunOwnsOutput(1, false)).toBe(true);
  });

  test("nothing was there to protect, so the path is this run's to clean up", () => {
    expect(failedRunOwnsOutput(0, false)).toBe(true);
  });
});
