import { expect, test } from "bun:test";
import { ffmpegFailedMessage, NoFramesDecodedError } from "../src/pipeline/ffmpeg-failure.ts";

test("a failed child is reported by stage and exit code, with what it printed trimmed", () => {
  expect(ffmpegFailedMessage("decode", 1, "  Invalid data found when processing input\r\n")).toBe("ffmpeg decode failed (1): Invalid data found when processing input");
  expect(ffmpegFailedMessage("mux", 183, "")).toBe("ffmpeg mux failed (183): ");
});

test("a decode that produced nothing says so, and still reads as a plain Error in a job's failure line", () => {
  const error = new NoFramesDecodedError();
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("No frames were decoded from the input. The file may be empty, corrupt, or not a video ffmpeg can read.");
  expect(error.stack?.split("\n")[0]).toBe(`Error: ${error.message}`);
});
