/**
 * The per-interval evaluate contract of DLSS Frame Generation: which EvaluateFeature calls one
 * source interval records, and how the disable flag of its first call decides what came out.
 */

/**
 * Size of each DLSSG.OutputDisableInterpolation buffer. The header asks for at least 4 bytes
 * (nvsdk_ngx_defs_dlssg.h:118-123, NVIDIA/DLSS v310.9.1); 256 is what every measurement on
 * nvngx_dlssg.dll 310.7.129 and 310.9.1 ran with.
 */
export const DISABLE_FLAG_BUFFER_BYTES = 256;

/**
 * Written into every disable-flag buffer before the evaluates. Measured on nvngx_dlssg.dll
 * 310.9.1, the runtime only ever writes 0 or 1 there, so this byte surviving a successful
 * MultiFrameIndex 1 evaluate means the feature produced nothing.
 */
export const DISABLE_FLAG_UNWRITTEN = 0xcd;

export interface EvaluateCall {
  multiFrameCount: number;
  /** 1-based and strictly increasing within the interval. */
  multiFrameIndex: number;
  reset: boolean;
}

/**
 * The calls one interval records on a single command list, in order (DLSS-FG Programming Guide
 * v310.7.0 p.108-109). A reset interval only has to take the current frame into the feature's
 * history, so it evaluates index 1 alone, and then it must declare MultiFrameCount 1: measured
 * on 310.9.1, declaring N and stopping after index 1 disables the next interval and makes the
 * one after it interpolate from the frame before the reset.
 */
export function intervalEvaluateCalls(generatedCount: number, reset: boolean): EvaluateCall[] {
  if (reset) return [{ multiFrameCount: 1, multiFrameIndex: 1, reset: true }];
  return Array.from({ length: generatedCount }, (_, index) => ({ multiFrameCount: generatedCount, multiFrameIndex: index + 1, reset: false }));
}

type IntervalReading = "generated" | "disabled" | "reset" | "resetIgnored" | "stale";

/**
 * Decides an interval from byte 0 of its MultiFrameIndex 1 disable flag alone. Measured on
 * 310.9.1: a generated interval writes 0 there and leaves the later indices' flags untouched;
 * a disabled one writes 1 into every flag and copies the backbuffer into every output; a reset
 * interval writes 1 like a disabled one, so a 0 on a reset means the runtime interpolated across
 * it instead of starting a new history. "stale" is a feature that stopped writing its flag; a
 * Reset does not recover it, only a new feature does.
 */
export function classifyInterval(flag: Uint8Array, reset: boolean): IntervalReading {
  const firstByte = flag[0];
  if (firstByte === undefined) throw new Error("classifyInterval: the disable flag read back empty; read back the whole MultiFrameIndex 1 flag buffer");
  if (firstByte === DISABLE_FLAG_UNWRITTEN) return "stale";
  if (reset) return firstByte === 0 ? "resetIgnored" : "reset";
  return firstByte === 0 ? "generated" : "disabled";
}
