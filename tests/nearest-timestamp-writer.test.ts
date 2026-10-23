import { describe, expect, test } from "bun:test";
import { NoFramesDecodedError } from "../src/pipeline/ffmpeg-failure.ts";
import { NearestTimestampWriter, type TimedFrame, outputFrameCount } from "../src/pipeline/nearest-timestamp-writer.ts";
import { type Rational, ratCmp, ratDiv, rational } from "../src/pipeline/rational.ts";

const eq = (a: Rational, b: Rational) => ratCmp(a, b) === 0;

describe("outputFrameCount", () => {
  test("ceil(duration * target)", () => {
    // 121 frames at 30 fps -> 4.0333 s -> 484 frames at 120 fps
    expect(outputFrameCount(rational(121, 30), rational(120))).toBe(484);
    // 29.97 -> 59.94 is exactly 2x: 1000 frames -> 2000
    const src = rational(30000, 1001);
    expect(outputFrameCount(rational(1000n * src.den, src.num), rational(60000, 1001))).toBe(2000);
    // 30 -> 144: 10 s -> 1440
    expect(outputFrameCount(rational(10), rational(144))).toBe(1440);
    expect(outputFrameCount(rational(0), rational(60))).toBe(0);
  });
});

describe("NearestTimestampWriter", () => {
  const mark = (id: number) => new Uint8Array([id]);
  const frame = (id: number, ts: Rational, provenance: "Source" | "DLSSG", sourceIndex: number | null = null, segment = 0): TimedFrame => ({
    rgba: mark(id),
    timestamp: ts,
    segment,
    provenance,
    sourceIndex,
  });

  test("real + generated stream at 2 fps resampled to 4 fps", async () => {
    const out: number[] = [];
    // 3 real frames at 2 fps (duration 3/2 s) -> 6 output frames at 4 fps
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(4));
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(10, rational(1, 4), "DLSSG"));
    await writer.push(frame(1, rational(1, 2), "Source", 1));
    await writer.push(frame(11, rational(3, 4), "DLSSG"));
    await writer.push(frame(2, rational(1), "Source", 2));
    writer.endAt(3, rational(2));
    expect(writer.outputCount).toBe(6);
    await writer.finish();
    expect(out).toEqual([0, 10, 1, 11, 2, 2]);
    expect(writer.generated).toBe(2);
    expect(writer.copied).toBe(4);
    expect([...writer.selectedRealIds].sort()).toEqual([0, 1, 2]);
    expect(eq(writer.maxError, rational(0))).toBe(true);
  });

  test("exact half-way ties alternate early/late", async () => {
    const out: number[] = [];
    // 3 real frames at 1 fps, no generated frames, target 2 fps -> 6 outputs
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2));
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(1, rational(1), "Source", 1));
    await writer.push(frame(2, rational(2), "Source", 2));
    writer.endAt(3, rational(1));
    await writer.finish();
    // t=0.5 tie -> early (0); t=1.5 tie -> late (2)
    expect(out).toEqual([0, 0, 1, 2, 2, 2]);
    expect(eq(writer.maxError, rational(1, 2))).toBe(true);
    expect(writer.generated).toBe(0);
  });

  test("missing generated frames (scene cut) are filled from real frames, length preserved", async () => {
    const out: number[] = [];
    // 2 real frames at 1 fps, target 4 fps, nothing generated -> still 8 outputs
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(4));
    await writer.push(frame(0, rational(0), "Source", 0));
    await writer.push(frame(1, rational(1), "Source", 1));
    writer.endAt(2, rational(1));
    await writer.finish();
    expect(out).toHaveLength(8);
    expect(out).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  });

  test("finish with no frames throws the shared no-frames error", async () => {
    const writer = new NearestTimestampWriter(() => {}, rational(4));
    await expect(writer.finish()).rejects.toBeInstanceOf(NoFramesDecodedError);
  });
});

// The length is fixed from the DECODED count at end of stream, so a container
// that declares the wrong number of frames — in either direction — cannot make
// the output the wrong length. Before this, a plan made from nb_frames could
// only be trimmed down, so a decode that ran LONGER than the container said was
// cut short (measured: a 240-frame 23.976-in-29.97 clip decodes to 300).
describe("NearestTimestampWriter.endAt", () => {
  const frame = (id: number, ts: Rational): TimedFrame => ({ rgba: new Uint8Array([id]), timestamp: ts, segment: 0, provenance: "Source", sourceIndex: id });

  test("fewer frames decoded than the container declared: output ends at the decoded length", async () => {
    const out: number[] = [];
    // A container claiming 3 frames at 1 fps would plan 6 outputs at 2 fps; only 2 decode.
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2));
    await writer.push(frame(0, rational(0)));
    await writer.push(frame(1, rational(1)));
    writer.endAt(2, rational(1));
    await writer.finish();
    expect(writer.outputCount).toBe(4);
    expect(out).toEqual([0, 0, 1, 1]);
  });

  test("more frames decoded than the container declared: output grows to the decoded length", async () => {
    const out: number[] = [];
    // A container claiming 2 frames at 1 fps would have capped this at 4; 3 actually decode.
    const writer = new NearestTimestampWriter((rgba) => { out.push(rgba[0]!); }, rational(2));
    await writer.push(frame(0, rational(0)));
    await writer.push(frame(1, rational(1)));
    await writer.push(frame(2, rational(2)));
    writer.endAt(3, rational(1));
    await writer.finish();
    expect(writer.outputCount).toBe(6);
    expect(out).toHaveLength(6);
  });

  test("push() never overruns the length endAt() will set, so the cap is only ever a floor", async () => {
    const writer = new NearestTimestampWriter(() => {}, rational(60));
    // 300 frames at 30000/1001: written indices satisfy k/target <= (N-1.5)/sourceRate.
    for (let i = 0; i < 300; i++) await writer.push(frame(i, ratDiv(rational(i), rational(30000, 1001))));
    const pushedBeforeEnd = writer.nextIndex;
    writer.endAt(300, rational(30000, 1001));
    expect(writer.outputCount).toBeGreaterThanOrEqual(pushedBeforeEnd);
    expect(writer.outputCount).toBe(601);
  });

  test("finish() before endAt() fails instead of padding forever", async () => {
    const writer = new NearestTimestampWriter(() => {}, rational(2));
    await writer.push(frame(0, rational(0)));
    await expect(writer.finish()).rejects.toThrow(/before endAt/);
  });
});
