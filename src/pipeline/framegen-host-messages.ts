/**
 * Why a DLSS Frame Generation session that should have generated came back with nothing, and what
 * the user can do about it.
 */
import { HOST_PROCESS_NAME } from "./dlssg-host-launch.ts";
import { type InterpolationPlan, formatRate, isNativeMultiFramePlan } from "./framegen-plan.ts";

export interface NoFramesGenerated {
  /** Frames for which the host reported generation disabled. */
  disabledFrames: number;
  hagsEnabled: boolean;
}

/**
 * Why a session that should have generated came back with nothing. The writer would still emit a
 * correctly timed file, but it would be a duplicate-frame resample sold as frame generation, so the
 * job fails with this instead.
 */
export function noFramesGeneratedMessage(plan: InterpolationPlan, { disabledFrames, hagsEnabled }: NoFramesGenerated): string {
  const wanted = `${formatRate(plan.sourceRate)} -> ${formatRate(plan.targetRate)} fps via ${plan.path}`;
  const reported = disabledFrames ? `; ${HOST_PROCESS_NAME} reported generation disabled for ${disabledFrames} frame(s)` : "";
  const multiFrame = isNativeMultiFramePlan(plan);
  const multiFrameRefused = ` The runtime disabled every interval at native ${plan.nativeMultiplier}x with HAGS on; the cascade engine reaches higher rates from 2x stages, and auto falls back to it automatically.`;
  const hint = multiFrame
    ? hagsEnabled
      ? multiFrameRefused
      : " Multi-frame (3x and above) DLSS Frame Generation requires Windows hardware-accelerated GPU scheduling (HAGS), which is off on this machine: enable it under Settings > System > Display > Graphics > Default graphics settings and reboot, or use the cascade engine (auto falls back to it automatically)."
    : " Check that the GPU driver is current and the dlssg runtime folder is complete; the cascade engine only needs 2x generation.";
  return `DLSS Frame Generation produced no interpolated frames (${wanted})${reported}.${hint} No output was written.`;
}
