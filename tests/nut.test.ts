import { expect, test } from "bun:test";
import {
  buildDecodeArgs,
  buildEncodeArgs,
  buildNutPrestageArgs,
  buildNvencProbeArgs,
  computeOutputTimestamps,
  cpuFallbackChain,
  cpuFallbackCodec,
  formatRational,
  isNativeGrid,
  NVENC_TO_CPU,
  parseRational,
  planAllNvencProbes,
  planNvencProbe,
  planOutputFrames,
  ratCeil,
  ratCmp,
  ratMul,
  rational,
} from "../src/pipeline/nut.ts";

// --- rational helpers -------------------------------------------------------

test("parseRational keeps exact rationals, integers, and decimals without float drift", () => {
  expect(parseRational("60000/1001")).toEqual({ num: 60000n, den: 1001n });
  expect(parseRational("24")).toEqual({ num: 24n, den: 1n });
  // 23.976 becomes an exact fraction 23976/1000 reduced, NOT the float 23.976.
  expect(formatRational(parseRational("23.976"))).toBe("2997/125");
  expect(formatRational(parseRational("30000/1001"))).toBe("30000/1001");
});

test("rational arithmetic reduces and compares exactly", () => {
  expect(ratMul(rational(24), rational(2))).toEqual({ num: 48n, den: 1n });
  expect(ratCmp(parseRational("60000/1001"), parseRational("60"))).toBe(-1);
  expect(ratCmp(rational(48), rational(48))).toBe(0);
  expect(ratCeil(rational(2002, 1))).toBe(2002n);
  expect(ratCeil(rational(2001, 1000))).toBe(3n);
  expect(ratCeil(rational(2000, 1000))).toBe(2n);
});

// --- decode / encode / prestage arg construction ---------------------------

test("buildDecodeArgs wraps the source as fps_mode-passthrough rawvideo", () => {
  const args = buildDecodeArgs({ ffmpeg: "ffmpeg", input: "in.mp4" });
  expect(args).toEqual([
    "ffmpeg", "-hide_banner", "-v", "warning", "-nostdin", "-i", "in.mp4",
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-fps_mode", "passthrough", "pipe:1",
  ]);
});

test("buildDecodeArgs inserts a lanczos scale filter when a working size is given", () => {
  const args = buildDecodeArgs({ input: "in.mkv", scale: { width: 1920, height: 1080 } });
  const i = args.indexOf("-vf");
  expect(i).toBeGreaterThan(-1);
  expect(args[i + 1]).toBe("scale=1920:1080:flags=lanczos");
  expect(args[0]).toBe("-hide_banner"); // no ffmpeg binary prepended when omitted
});

test("buildEncodeArgs consumes the NUT pipe with passthrough + enc_time_base demux", () => {
  const args = buildEncodeArgs({
    ffmpeg: "ffmpeg",
    output: "job/video.nut",
    codecArgs: ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p"],
  });
  expect(args).toEqual([
    "ffmpeg", "-hide_banner", "-loglevel", "warning", "-y",
    "-f", "nut", "-i", "pipe:0", "-map", "0:v:0", "-an",
    "-fps_mode", "passthrough", "-enc_time_base:v", "demux",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
    "job/video.nut",
  ]);
});

test("buildEncodeArgs can drop enc_time_base and add copyts / avoid_negative_ts", () => {
  const args = buildEncodeArgs({
    output: "out.nut",
    codecArgs: ["-c:v", "libx265"],
    preserveTimestamps: false,
    copyts: true,
    avoidNegativeTs: true,
  });
  expect(args).not.toContain("-enc_time_base:v");
  expect(args).toContain("-copyts");
  expect(args.slice(args.indexOf("-avoid_negative_ts"), args.indexOf("-avoid_negative_ts") + 2)).toEqual([
    "-avoid_negative_ts", "disabled",
  ]);
  // passthrough is ALWAYS present.
  expect(args).toContain("-fps_mode");
  expect(args).toContain("passthrough");
});

test("buildNutPrestageArgs stamps exact rational CFR PTS via -framerate and copies to NUT", () => {
  const args = buildNutPrestageArgs({ width: 3840, height: 2160, rate: parseRational("60000/1001") });
  expect(args).toEqual([
    "-hide_banner", "-loglevel", "warning", "-y",
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "3840x2160",
    "-framerate", "60000/1001", "-i", "pipe:0", "-map", "0:v:0", "-an",
    "-c:v", "copy", "-f", "nut", "pipe:1",
  ]);
  // string rate accepted verbatim
  expect(buildNutPrestageArgs({ width: 100, height: 100, rate: "48/1" })).toContain("48/1");
});

// --- rational-PTS timeline & nearest-timestamp resample --------------------

test("native 24 -> 48 (grid 2) yields contiguous CFR PTS with trailing duplicate", () => {
  const inputs = [0n, 1n, 2n, 3n, 4n]; // 5 input frames
  const plan = planOutputFrames(inputs, rational(24), rational(48), 2);
  expect(plan.mode).toBe("native");
  // duration = 5/24 s ; outputCount = ceil(5/24 * 48) = 10
  expect(plan.outputCount).toBe(10);
  expect(plan.pts).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
  // fine timeline has (5-1)*2+1 = 9 frames (indices 0..8); slot 9 clamps to 8 (holds last).
  expect(plan.fineCount).toBe(9);
  expect(plan.sourceSelection).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8]);
  expect(isNativeGrid(rational(24), rational(48), 2)).toBe(true);
});

test("native 24 -> 72 (grid 3) places 2 generated frames between each real frame", () => {
  const inputs = [0n, 1n, 2n]; // 3 input frames
  const plan = planOutputFrames(inputs, rational(24), rational(72), 3);
  expect(plan.mode).toBe("native");
  expect(plan.outputCount).toBe(9); // ceil(3/24 * 72)
  expect(plan.fineCount).toBe(7); // (3-1)*3+1
  // dyadic frames 0..6, then 2 trailing holds of frame 6
  expect(plan.sourceSelection).toEqual([0, 1, 2, 3, 4, 5, 6, 6, 6]);
});

test("computeOutputTimestamps returns just the PTS array (delegates to planOutputFrames)", () => {
  const inputs = Array.from({ length: 3 }, (_, i) => BigInt(i));
  expect(computeOutputTimestamps(inputs, rational(24), rational(48), 2)).toEqual([0n, 1n, 2n, 3n, 4n, 5n]);
});

test("cascade 23.976 -> 480 (grid 8) upsamples with nearest-timestamp duplication", () => {
  const source = parseRational("24000/1001"); // 23.976
  const target = rational(480);
  const n = 100;
  const inputs = Array.from({ length: n }, (_, i) => BigInt(i));
  const plan = planOutputFrames(inputs, source, target, 8);
  expect(plan.mode).toBe("cascade"); // 480 / 23.976 = 20.02, not 8*source
  expect(isNativeGrid(source, target, 8)).toBe(false);
  // duration = 100/23.976 s ; outputCount = ceil(100 * 1001/24000 * 480) = ceil(2002.0) = 2002
  expect(plan.outputCount).toBe(2002);
  expect(plan.pts.length).toBe(2002);
  expect(plan.pts[0]).toBe(0n);
  expect(plan.pts[2001]).toBe(2001n);
  // fine timeline only has (100-1)*8+1 = 793 distinct frames -> heavy duplication feeding 2002 slots
  expect(plan.fineCount).toBe(793);
  // selection is monotonic non-decreasing, starts at 0, clamps at fineMax (792)
  expect(plan.sourceSelection[0]).toBe(0);
  expect(Math.max(...plan.sourceSelection)).toBe(792);
  for (let k = 1; k < plan.sourceSelection.length; k++) {
    expect(plan.sourceSelection[k]!).toBeGreaterThanOrEqual(plan.sourceSelection[k - 1]!);
  }
  // more outputs than distinct source frames => at least one duplicate exists
  expect(plan.outputCount).toBeGreaterThan(plan.fineCount);
});

test("cascade 24 -> 60 (2.5x, grid 8) is not native and counts frames exactly", () => {
  const inputs = Array.from({ length: 48 }, (_, i) => BigInt(i));
  const plan = planOutputFrames(inputs, rational(24), rational(60), 8);
  expect(plan.mode).toBe("cascade");
  // ceil(48/24 * 60) = 120
  expect(plan.outputCount).toBe(120);
});

test("planOutputFrames treats target<=source or grid<2 as passthrough", () => {
  const inputs = [0n, 1n, 2n, 3n];
  const down = planOutputFrames(inputs, rational(60), rational(24), 8);
  expect(down.outputCount).toBe(4);
  expect(down.pts).toEqual([0n, 1n, 2n, 3n]);
  expect(down.sourceSelection).toEqual([0, 1, 2, 3]);
  const g1 = planOutputFrames(inputs, rational(24), rational(48), 1);
  expect(g1.outputCount).toBe(4);
});

test("planOutputFrames rejects an empty input list", () => {
  expect(() => planOutputFrames([], rational(24), rational(48), 2)).toThrow();
});

// --- NVENC probe planner & fallback map ------------------------------------

test("buildNvencProbeArgs builds the 1-frame lavfi null test with optional -gpu", () => {
  expect(buildNvencProbeArgs({ ffmpeg: "ffmpeg", codec: "h264_nvenc" })).toEqual([
    "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=256x256:rate=1",
    "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-",
  ]);
  const withGpu = buildNvencProbeArgs({ codec: "hevc_nvenc", width: 3840, height: 2160, gpu: 1 });
  expect(withGpu).toContain("color=size=3840x2160:rate=1");
  expect(withGpu.slice(withGpu.indexOf("-gpu"), withGpu.indexOf("-gpu") + 2)).toEqual(["-gpu", "1"]);
  // gpu 0 must still be emitted (ordinal 0 is valid, not "missing")
  expect(buildNvencProbeArgs({ codec: "av1_nvenc", gpu: 0 })).toContain("-gpu");
});

test("CPU fallback map and chains match the reference codec resolution", () => {
  expect(NVENC_TO_CPU).toEqual({ h264_nvenc: "libx264", hevc_nvenc: "libx265", av1_nvenc: "libsvtav1" });
  expect(cpuFallbackCodec("hevc_nvenc")).toBe("libx265");
  expect(cpuFallbackChain("av1_nvenc")).toEqual(["libsvtav1", "libaom-av1"]);
  expect(cpuFallbackChain("h264_nvenc")).toEqual(["libx264"]);
});

test("planNvencProbe / planAllNvencProbes bundle args, display name and fallback", () => {
  const plan = planNvencProbe({ ffmpeg: "ffmpeg", codec: "av1_nvenc", gpu: 2 });
  expect(plan.displayName).toBe("AV1 (NVIDIA NVENC)");
  expect(plan.fallbackChain).toEqual(["libsvtav1", "libaom-av1"]);
  expect(plan.args).toContain("av1_nvenc");
  expect(plan.args).toContain("-gpu");

  const all = planAllNvencProbes({ width: 256, height: 256 });
  expect(all.map((p) => p.codec)).toEqual(["h264_nvenc", "hevc_nvenc", "av1_nvenc"]);
  expect(all.every((p) => p.args.includes("null"))).toBe(true);
});
