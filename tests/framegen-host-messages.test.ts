/**
 * What frame generation says when a session that should have generated came back with nothing
 * (src/pipeline/framegen-host-messages.ts): every interval refused at native 4x, HAGS off, and 2x.
 * No process or GPU.
 */
import { describe, expect, test } from "bun:test";
import { HOST_PROCESS_NAME } from "../src/pipeline/dlssg-host-launch.ts";
import { noFramesGeneratedMessage } from "../src/pipeline/framegen-host-messages.ts";
import { type InterpolationPlan, chooseInterpolationPlan } from "../src/pipeline/framegen-plan.ts";
import { rational } from "../src/pipeline/rational.ts";

function nativePlan(multiplier: number): InterpolationPlan {
  return chooseInterpolationPlan(rational(30), rational(30 * multiplier), "native", 6, { cfr: true, hagsEnabled: true });
}

describe("noFramesGeneratedMessage", () => {
  test("every interval disabled at native 4x names the multiplier the runtime refused", () => {
    expect(noFramesGeneratedMessage(nativePlan(4), { disabledFrames: 8, hagsEnabled: true })).toBe(
      `DLSS Frame Generation produced no interpolated frames (30 -> 120 fps via Native DLSSG); ${HOST_PROCESS_NAME} reported generation disabled for 8 frame(s). The runtime disabled every interval at native 4x with HAGS on; the cascade engine reaches higher rates from 2x stages, and auto falls back to it automatically. No output was written.`,
    );
  });

  test("multi-frame with HAGS off says how to turn it on", () => {
    const message = noFramesGeneratedMessage(nativePlan(3), { disabledFrames: 0, hagsEnabled: false });
    expect(message).toContain("requires Windows hardware-accelerated GPU scheduling (HAGS), which is off on this machine");
    expect(message).not.toContain("reported generation disabled");
  });

  test("a 2x session that produced nothing points at the driver and the runtime folder", () => {
    const message = noFramesGeneratedMessage(nativePlan(2), { disabledFrames: 3, hagsEnabled: true });
    expect(message).toContain(`(30 -> 60 fps via Native DLSSG); ${HOST_PROCESS_NAME} reported generation disabled for 3 frame(s). Check that the GPU driver is current`);
  });
});
