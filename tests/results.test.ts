/**
 * The text NgxError gives the NGX results users see (src/ngx/results.ts). No GPU.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_SR_PRESET, DlssRenderPreset, NgxError } from "../src/ngx/results.ts";

describe("NgxError", () => {
  test("PlatformError names the call and the result, and no feature, since any feature's call can return it", () => {
    const message = new NgxError(0xbad00002, "DLSS Frame Generation EvaluateFeature (MultiFrameIndex 1 of 1)").message;
    expect(message).toStartWith("DLSS Frame Generation EvaluateFeature (MultiFrameIndex 1 of 1): NGX PlatformError (0xBAD00002) - a platform error inside the NGX runtime");
    expect(message).not.toMatch(/feature \d+/i);
  });

  test("a result without a hint is named with its code alone", () => {
    expect(new NgxError(0xbad00005, "CreateFeature").message).toBe("CreateFeature: NGX InvalidParameter (0xBAD00005)");
  });
});

describe("DEFAULT_SR_PRESET", () => {
  test("names a render preset the runtime defines, in the case the table spells it", () => {
    expect(Object.keys(DlssRenderPreset)).toContain(DEFAULT_SR_PRESET);
    expect(DlssRenderPreset[DEFAULT_SR_PRESET]).toBe(12);
  });
});
