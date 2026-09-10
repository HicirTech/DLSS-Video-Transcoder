/** ffprobe's JSON -> VideoInfo: the rate fields are argv for ffmpeg, so they must never be unusable. */
import { describe, expect, test } from "bun:test";
import { videoInfoFrom, type ProbeJson } from "../src/pipeline/video.ts";

const stream = (rates: { r?: string; avg?: string }, rotation?: number, geometry?: { width: number; height: number; sar?: string }): ProbeJson => ({
  streams: [{
    codec_type: "video", codec_name: "h264", width: geometry?.width ?? 1920, height: geometry?.height ?? 1080,
    r_frame_rate: rates.r, avg_frame_rate: rates.avg, nb_frames: "300",
    ...(rotation === undefined ? null : { side_data_list: [{ rotation }] }),
    ...(geometry?.sar === undefined ? null : { sample_aspect_ratio: geometry.sar }),
  }],
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

  // ffmpeg autorotates on decode, so a portrait clip coded 1920x1080 with a
  // 90-degree matrix arrives as 1080x1920. width*height is unchanged, so nothing
  // downstream can detect the transposition on its own.
  test("reports display geometry for a rotated stream", () => {
    for (const deg of [90, -90, 270, -270, 450]) {
      const info = videoInfoFrom(stream({ r: "30/1" }, deg), "portrait.mp4");
      expect([info.width, info.height]).toEqual([1080, 1920]);
    }
  });

  test("leaves geometry alone for 0 and 180 degrees, and when there is no side data", () => {
    for (const deg of [0, 180, -180, 360]) {
      const info = videoInfoFrom(stream({ r: "30/1" }, deg), "landscape.mp4");
      expect([info.width, info.height]).toEqual([1920, 1080]);
    }
    expect(videoInfoFrom(stream({ r: "30/1" }), "plain.mp4").width).toBe(1920);
  });

  test("normalises the reported rotation to (-180, 180]", () => {
    expect(videoInfoFrom(stream({ r: "30/1" }, 270), "a.mp4").rotation).toBe(-90);
    expect(videoInfoFrom(stream({ r: "30/1" }, -90), "a.mp4").rotation).toBe(-90);
    expect(videoInfoFrom(stream({ r: "30/1" }, 90), "a.mp4").rotation).toBe(90);
    expect(videoInfoFrom(stream({ r: "30/1" }), "a.mp4").rotation).toBe(0);
  });

  // ffprobe emits r_frame_rate="1/0" for a stream whose track duration is zero;
  // ffmpeg then rejects "-framerate 1/0" outright.
  test("treats a zero or unparseable denominator as no rate at all", () => {
    for (const bad of ["1/0", "30/x", "x/1", "-30/1", "0/1"]) {
      const info = videoInfoFrom(stream({ r: bad, avg: bad }), "odd.mp4");
      expect(info.fpsText).toBe("30");
      expect(info.nominalFpsText).toBe("30");
      expect(info.fps).toBe(30);
    }
  });

  test("a bare integer rate is still a rate", () => {
    expect(videoInfoFrom(stream({ r: "25", avg: "25" }), "a.mp4").fpsText).toBe("25");
  });

  // The rawvideo pipe drops the sample aspect ratio, so the display ratio is
  // carried instead: it is what a rescale preserves and what both sinks take.
  test("a 720x480 DVD at SAR 8:9 reports DAR 4:3", () => {
    const info = videoInfoFrom(stream({ r: "30000/1001" }, undefined, { width: 720, height: 480, sar: "8:9" }), "dvd.mp4");
    expect(info.displayAspect).toEqual({ num: 4n, den: 3n });
  });

  test("a 1440x1080 HDV capture at SAR 4:3 reports DAR 16:9", () => {
    const info = videoInfoFrom(stream({ r: "30000/1001" }, undefined, { width: 1440, height: 1080, sar: "4:3" }), "hdv.mp4");
    expect(info.displayAspect).toEqual({ num: 16n, den: 9n });
  });

  test("square pixels and unusable values report nothing to restore", () => {
    for (const sar of ["1:1", "0:1", "N/A", undefined]) {
      expect(videoInfoFrom(stream({ r: "30/1" }, undefined, { width: 1920, height: 1080, sar }), "a.mp4").displayAspect).toBeNull();
    }
  });

  test("a 90-degree rotation inverts the sample aspect along with the geometry", () => {
    const info = videoInfoFrom(stream({ r: "30000/1001" }, 90, { width: 720, height: 480, sar: "8:9" }), "portrait-dvd.mp4");
    expect([info.width, info.height]).toEqual([480, 720]);
    expect(info.displayAspect).toEqual({ num: 3n, den: 4n });
  });

  test("rejects a file with no usable video stream", () => {
    expect(() => videoInfoFrom({ streams: [{ codec_type: "audio" }] }, "song.mp3")).toThrow(/no video stream/);
  });
});
