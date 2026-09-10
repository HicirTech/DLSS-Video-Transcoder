/** ffprobe's JSON -> VideoInfo: the rate fields are argv for ffmpeg, so they must never be unusable. */
import { describe, expect, test } from "bun:test";
import { videoInfoFrom, type ProbeJson } from "../src/pipeline/video.ts";

const stream = (rates: { r?: string; avg?: string }): ProbeJson => ({
  streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: rates.r, avg_frame_rate: rates.avg, nb_frames: "300" }],
  format: { duration: "10.0" },
});

describe("videoInfoFrom", () => {
  test("prefers the measured rate, and the nominal clock for planning", () => {
    const info = videoInfoFrom(stream({ r: "30000/1001", avg: "24000/1001" }), "in.mp4");
    expect(info.fpsText).toBe("24000/1001");
    expect(info.nominalFpsText).toBe("30000/1001");
  });

  test("falls through to the other rate when one is 0/0", () => {
    expect(videoInfoFrom(stream({ r: "50/1", avg: "0/0" }), "in.mp4").fpsText).toBe("50/1");
    expect(videoInfoFrom(stream({ r: "0/0", avg: "50/1" }), "in.mp4").nominalFpsText).toBe("50/1");
  });

  // The defect: `?? ` only substituted for undefined, so a defined "0/0" reached
  // ffmpeg as `-framerate 0/0`, which it rejects outright.
  test("never emits an unusable rate when both are 0/0", () => {
    const info = videoInfoFrom(stream({ r: "0/0", avg: "0/0" }), "in.mp4");
    expect(info.fpsText).toBe("30");
    expect(info.nominalFpsText).toBe("30");
    expect(info.fps).toBe(30);
  });

  test("treats N/A and a missing rate the same way", () => {
    expect(videoInfoFrom(stream({ r: "N/A", avg: undefined }), "in.mp4").fpsText).toBe("30");
    expect(videoInfoFrom(stream({}), "in.mp4").nominalFpsText).toBe("30");
  });

  test("frames come from nb_frames, else duration x rate", () => {
    expect(videoInfoFrom(stream({ r: "30/1", avg: "30/1" }), "in.mp4").frames).toBe(300);
    const noCount: ProbeJson = { streams: [{ codec_type: "video", width: 640, height: 480, r_frame_rate: "25/1", nb_frames: "N/A" }], format: { duration: "4.0" } };
    expect(videoInfoFrom(noCount, "in.mp4").frames).toBe(100);
  });

  test("rejects a file with no usable video stream", () => {
    expect(() => videoInfoFrom({ streams: [{ codec_type: "audio" }] }, "song.mp3")).toThrow(/no video stream/);
  });
});
