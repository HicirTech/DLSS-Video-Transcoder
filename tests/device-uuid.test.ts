import { describe, expect, test } from "bun:test";
import { DEVICE_UUID_PATTERN, formatDeviceUuid } from "../src/native/device-uuid.ts";

describe("device UUID", () => {
  test("formats a CUuuid the way nvidia-smi prints it", () => {
    const bytes = Uint8Array.from([0x52, 0x4e, 0x83, 0x73, 0x5f, 0xe1, 0x44, 0xb3, 0xc0, 0xaa, 0xcd, 0xbe, 0x91, 0x7e, 0x7e, 0xd2]);
    expect(formatDeviceUuid(bytes)).toBe("GPU-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2");
  });

  test("pads single-digit bytes, so every group keeps its length", () => {
    expect(formatDeviceUuid(new Uint8Array(16))).toBe("GPU-00000000-0000-0000-0000-000000000000");
  });

  test("the pattern accepts everything the formatter produces", () => {
    for (let seed = 0; seed < 64; seed++) {
      const bytes = Uint8Array.from({ length: 16 }, (_, index) => (seed * 37 + index * 101 + (index << seed % 5)) & 0xff);
      expect(DEVICE_UUID_PATTERN.test(formatDeviceUuid(bytes)), formatDeviceUuid(bytes)).toBe(true);
    }
  });

  test("the pattern rejects other spellings", () => {
    for (const bad of [
      "gpu-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2", // prefix is upper case
      "GPU-524E8373-5FE1-44B3-C0AA-CDBE917E7ED2", // hex is lower case
      "524e8373-5fe1-44b3-c0aa-cdbe917e7ed2", // no prefix
      "GPU-524e837-5fe1-44b3-c0aa-cdbe917e7ed2", // first group one digit short
      "GPU-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2f", // last group one digit long
      " GPU-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2", // leading space
      "0",
    ]) {
      expect(DEVICE_UUID_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
