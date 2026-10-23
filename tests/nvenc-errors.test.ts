/**
 * Which NVENC failure an encode reports (src/pipeline/nvenc.ts): the input is always unmapped, but a failed unmap
 * does not replace the encode error that came first. A stand-in function table answers; no GPU or driver.
 */
import { describe, expect, test } from "bun:test";
import { NvencEncoder } from "../src/pipeline/nvenc.ts";

const SUCCESS = 0;
const INVALID_PARAM = 8;
const MAP_FAILED = 16;

/** An encoder on a stand-in function table whose calls return the given statuses. The session handle 0n skips the driver's last-error lookup. */
function encoderAnswering(statuses: { encodePicture: number; unmapInput: number }, unmapped: string[]): NvencEncoder {
  const api = {
    encodePicture: () => statuses.encodePicture,
    lockBitstream: () => SUCCESS,
    unlockBitstream: () => SUCCESS,
    mapInput: () => SUCCESS,
    unmapInput: () => {
      unmapped.push("unmapInput");
      return statuses.unmapInput;
    },
    lastError: () => 0,
  };
  // The constructor is private to keep callers on open(); its parameters are (enc, width, height, device, pitch,
  // ownsDevice, registeredList, bitstream, api, presetConfig).
  const Encoder = NvencEncoder as unknown as new (...parts: unknown[]) => NvencEncoder;
  return new Encoder(0n, 2, 2, 0n, 8, false, [1n], 1n, api, new Uint8Array(0));
}

describe("NvencEncoder.encodeGpuResident", () => {
  test("an encode failure is reported even when unmapping the input fails as well", () => {
    const unmapped: string[] = [];
    const encoder = encoderAnswering({ encodePicture: INVALID_PARAM, unmapInput: MAP_FAILED }, unmapped);
    expect(() => encoder.encodeGpuResident(0)).toThrow("NVENC nvEncEncodePicture failed: INVALID_PARAM (8)");
    expect(unmapped).toEqual(["unmapInput"]);
  });

  test("a failed unmap after a good encode is still reported", () => {
    const encoder = encoderAnswering({ encodePicture: SUCCESS, unmapInput: MAP_FAILED }, []);
    expect(() => encoder.encodeGpuResident(0)).toThrow("NVENC nvEncUnmapInputResource failed: MAP_FAILED (16)");
  });
});
