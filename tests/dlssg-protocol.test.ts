/**
 * The FGS2/FGR1/FGF3/FGO2 messages against golden bytes written out by hand from the layout
 * the host reads, so a moved field or a big-endian write fails here rather than on the GPU; and
 * the `--probe` line's snake_case keys.
 */
import { describe, expect, test } from "bun:test";
import {
  FRAME_HEADER_BYTES,
  FRAME_RESULT_BYTES,
  HostStatus,
  SETUP_BYTES,
  SETUP_REPLY_BYTES,
  decodeFrameHeader,
  decodeFrameResult,
  decodeProbeLine,
  decodeSetup,
  decodeSetupReply,
  encodeFrameHeader,
  encodeFrameResult,
  encodeProbeLine,
  encodeSetup,
  encodeSetupReply,
  motionFieldBytes,
  rgbaFrameBytes,
  type DlssgFrameResult,
} from "../src/pipeline/dlssg-protocol.ts";

/** Bytes from space-separated hex pairs, grouped by field in the tests for readability. */
function hex(text: string): Uint8Array {
  return Uint8Array.from(text.trim().split(/\s+/), (pair) => parseInt(pair, 16));
}

const FGS2 = "46 47 53 32";
const FGR1 = "46 47 52 31";
const FGF3 = "46 47 46 33";
const FGO2 = "46 47 4f 32";
/** The frame magics of the protocol whose pixels followed the messages on the pipe. */
const FGF1 = "46 47 46 31";
const FGO1 = "46 47 4f 31";
/** The setup and frame header magics of the layouts that still carried fields nothing read. */
const FGS1 = "46 47 53 31";
const FGF2 = "46 47 46 32";

describe("FGS2 setup", () => {
  const setup = { width: 1280, height: 720, generatedCount: 1 };
  const golden = hex(`${FGS2}  00 05 00 00  d0 02 00 00  01 00 00 00`);

  test("encodes magic, width, height, generatedCount as little-endian u32", () => {
    expect(encodeSetup(setup)).toEqual(golden);
    expect(golden.byteLength).toBe(SETUP_BYTES);
  });

  test("decodes what it encodes", () => {
    expect(decodeSetup(golden)).toEqual(setup);
  });

  test("rejects another message's magic", () => {
    expect(() => decodeSetup(hex(`${FGF3} ${"00 ".repeat(12)}`))).toThrow("DLSSG setup: bad request magic");
  });

  test("rejects the previous layout's magic, so a peer that still sends a frame count is not served", () => {
    expect(() => decodeSetup(hex(`${FGS1} ${"00 ".repeat(12)}`))).toThrow("DLSSG setup: bad request magic");
  });
});

describe("FGR1 setup reply", () => {
  test("ready: status 0, then maximum, then a zero reserved word", () => {
    const golden = hex(`${FGR1}  00 00 00 00  05 00 00 00  00 00 00 00`);
    expect(encodeSetupReply({ outcome: "ready", maximum: 5 })).toEqual(golden);
    expect(golden.byteLength).toBe(SETUP_REPLY_BYTES);
    expect(decodeSetupReply(golden)).toEqual({ outcome: "ready", maximum: 5 });
  });

  test("refused: any non-zero status, whatever the other words hold", () => {
    expect(encodeSetupReply({ outcome: "refused", status: 7 })).toEqual(hex(`${FGR1}  07 00 00 00  00 00 00 00  00 00 00 00`));
    expect(decodeSetupReply(hex(`${FGR1}  0a 00 d0 ba  05 00 00 00  00 00 00 00`))).toEqual({ outcome: "refused", status: 0xbad0000a });
  });

  test("the reserved word is ignored", () => {
    expect(decodeSetupReply(hex(`${FGR1}  00 00 00 00  03 00 00 00  ff ff ff ff`))).toEqual({ outcome: "ready", maximum: 3 });
  });

  test("a refusal cannot be encoded with status 0", () => {
    expect(() => encodeSetupReply({ outcome: "refused", status: 0 })).toThrow("non-zero status");
  });

  test("rejects another message's magic", () => {
    expect(() => decodeSetupReply(hex(`${FGO2}  00 00 00 00  05 00 00 00  00 00 00 00`))).toThrow("DLSSG setup: bad reply magic");
  });
});

describe("FGF3 frame header", () => {
  const header = { index: 0x04030201, reset: true };
  const golden = hex(`${FGF3}  01 02 03 04  01 00 00 00  00 00 00 00`);

  test("encodes magic, index, reset and a zero reserved word as little-endian u32", () => {
    expect(encodeFrameHeader(header)).toEqual(golden);
    expect(golden.byteLength).toBe(FRAME_HEADER_BYTES);
  });

  test("reset false is a zero word", () => {
    expect(encodeFrameHeader({ ...header, reset: false }).subarray(8, 12)).toEqual(hex("00 00 00 00"));
  });

  test("decodes what it encodes", () => {
    expect(decodeFrameHeader(golden)).toEqual(header);
  });

  test("rejects another message's magic", () => {
    expect(() => decodeFrameHeader(hex(`${FGS2} ${"00 ".repeat(12)}`))).toThrow("DLSSG frame: bad request magic");
  });

  test("rejects the previous protocols' magics, so a parent that still sends pixels on the pipe or timestamps is not served", () => {
    expect(() => decodeFrameHeader(hex(`${FGF1} ${"00 ".repeat(12)}`))).toThrow("DLSSG frame: bad request magic");
    expect(() => decodeFrameHeader(hex(`${FGF2} ${"00 ".repeat(12)}`))).toThrow("DLSSG frame: bad request magic");
  });
});

describe("FGO2 frame result", () => {
  const goldens: [DlssgFrameResult, string][] = [
    [{ outcome: "generated", frameCount: 3 }, `${FGO2}  00 00 00 00  03 00 00 00  00 00 00 00`],
    [{ outcome: "empty" }, `${FGO2}  00 00 00 00  00 00 00 00  00 00 00 00`],
    [{ outcome: "disabled" }, `${FGO2}  00 00 00 00  00 00 00 00  01 00 00 00`],
    [{ outcome: "failed", status: 0xbad0000a }, `${FGO2}  0a 00 d0 ba  00 00 00 00  00 00 00 00`],
  ];

  test("encodes magic, status, generated, disabled as little-endian u32", () => {
    for (const [result, golden] of goldens) {
      expect(encodeFrameResult(result)).toEqual(hex(golden));
      expect(hex(golden).byteLength).toBe(FRAME_RESULT_BYTES);
    }
  });

  test("decodes what it encodes for a session generating 3 per interval", () => {
    for (const [result, golden] of goldens) expect(decodeFrameResult(hex(golden))).toEqual(result);
  });

  test("any non-zero disabled word means disabled", () => {
    expect(decodeFrameResult(hex(`${FGO2}  00 00 00 00  00 00 00 00  02 00 00 00`))).toEqual({ outcome: "disabled" });
  });

  test("a non-zero status is a failure whatever the other words hold", () => {
    expect(decodeFrameResult(hex(`${FGO2}  01 00 00 00  07 00 00 00  01 00 00 00`))).toEqual({ outcome: "failed", status: 1 });
  });

  test("the generated word is taken as sent, whatever the session asked for", () => {
    expect(decodeFrameResult(hex(`${FGO2}  00 00 00 00  01 00 00 00  00 00 00 00`))).toEqual({ outcome: "generated", frameCount: 1 });
    expect(decodeFrameResult(hex(`${FGO2}  00 00 00 00  07 00 00 00  00 00 00 00`))).toEqual({ outcome: "generated", frameCount: 7 });
  });

  test("a disabled reply carries no payload even when its generated word is non-zero", () => {
    expect(decodeFrameResult(hex(`${FGO2}  00 00 00 00  03 00 00 00  01 00 00 00`))).toEqual({ outcome: "disabled" });
  });

  test("rejects a view that is not exactly one message long", () => {
    const golden = hex(goldens[0]![1]);
    expect(() => decodeFrameResult(golden.subarray(0, FRAME_RESULT_BYTES - 1))).toThrow("DLSSG frame reply: got 15 bytes, expected 16");
    expect(() => decodeSetupReply(hex(`${FGR1} ${"00 ".repeat(13)}`))).toThrow("DLSSG setup reply: got 17 bytes, expected 16");
  });

  test("results that would decode as another outcome cannot be encoded", () => {
    expect(() => encodeFrameResult({ outcome: "generated", frameCount: 0 })).toThrow("at least one frame");
    expect(() => encodeFrameResult({ outcome: "failed", status: 0 })).toThrow("non-zero status");
  });

  test("decodes from a view that does not start its buffer", () => {
    const stream = hex(`ee ee ee ee  ${goldens[0]![1]}  ee ee`);
    expect(decodeFrameResult(stream.subarray(4, 4 + FRAME_RESULT_BYTES))).toEqual({ outcome: "generated", frameCount: 3 });
  });

  test("rejects another message's magic", () => {
    expect(() => decodeFrameResult(hex(`${FGR1}  00 00 00 00  00 00 00 00  00 00 00 00`))).toThrow("DLSSG frame: bad reply magic");
  });

  test("rejects the previous protocol's magic, so a host that still sends pixels on the pipe is not believed", () => {
    expect(() => decodeFrameResult(hex(`${FGO1}  00 00 00 00  03 00 00 00  00 00 00 00`))).toThrow("DLSSG frame: bad reply magic");
  });
});

describe("HostStatus", () => {
  test("every status is a distinct non-zero word, since the parent reads zero as success", () => {
    const statuses = Object.values(HostStatus);
    expect(statuses.every((status) => status > 0)).toBe(true);
    expect(new Set(statuses).size).toBe(statuses.length);
  });
});

describe("payload sizes", () => {
  test("an RGBA8 frame and an R16G16_FLOAT motion field are both 4 bytes per pixel", () => {
    expect(rgbaFrameBytes(1280, 720)).toBe(3_686_400);
    expect(motionFieldBytes(1280, 720)).toBe(3_686_400);
    expect(rgbaFrameBytes(3, 2)).toBe(24);
    expect(motionFieldBytes(3, 2)).toBe(24);
  });
});

describe("--probe line", () => {
  const probe = { available: true, multiFrameCountMax: 5, runtimeVersion: "310.7.129.0", detail: "generates up to 5 frame(s) per interval (6x)" };

  test("encodes one line with snake_case keys", () => {
    const line = encodeProbeLine(probe);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ available: true, multi_frame_count_max: 5, runtime_version: "310.7.129.0", detail: "generates up to 5 frame(s) per interval (6x)" });
  });

  test("decodes what it encodes", () => {
    expect(decodeProbeLine(encodeProbeLine(probe))).toEqual(probe);
  });

  test("a field the process left out reads as false, 0 or an empty string", () => {
    expect(decodeProbeLine("{}")).toEqual({ available: false, multiFrameCountMax: 0, runtimeVersion: "", detail: "" });
  });

  test("rejects a line that is not JSON", () => {
    expect(() => decodeProbeLine("host ready")).toThrow(SyntaxError);
  });
});
