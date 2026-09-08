/**
 * Encoder selection: prefer GPU (NVENC) encoding, fall back to CPU when NVENC is
 * unavailable or fails its probe.
 *
 * The video and frame-generation encode paths both call `resolveEncodeCodec` so
 * that a requested `*_nvenc` codec that cannot actually run on this machine
 * degrades to its CPU sibling instead of failing the whole job. The pure helpers
 * (`isNvenc`, `cpuSiblingCodec`, `preferredDefaultCodec`) are unit-tested; the
 * probe is a thin `ffmpeg` wrapper around nut.ts's probe-argument builder.
 */
import type { EncodeSettings } from "../server/api-types.ts";
import { NVENC_CODECS, type NvencCodec, buildNvencProbeArgs } from "./nut.ts";

export type Codec = EncodeSettings["codec"];

const NVENC_SET: ReadonlySet<string> = new Set(NVENC_CODECS);

/** True when the codec is a hardware NVENC encoder. */
export function isNvenc(codec: string): codec is NvencCodec {
  return NVENC_SET.has(codec);
}

/** The CPU EncodeSettings codec that produces the same format as an NVENC codec. */
const NVENC_TO_CPU_CODEC: Record<NvencCodec, Codec> = {
  h264_nvenc: "h264",
  hevc_nvenc: "hevc",
  av1_nvenc: "av1",
};

/** The CPU sibling for an NVENC codec, or the codec itself when already CPU. */
export function cpuSiblingCodec(codec: Codec): Codec {
  return isNvenc(codec) ? NVENC_TO_CPU_CODEC[codec] : codec;
}

/** The codec to default to when the caller has no explicit choice: GPU when available. */
export function preferredDefaultCodec(nvencAvailable: boolean): Codec {
  return nvencAvailable ? "h264_nvenc" : "h264";
}

/** Run nut.ts's one-frame NVENC probe; true only if the encoder actually runs. */
export function probeNvenc(ffmpeg: string, codec: NvencCodec, gpu?: number): boolean {
  try {
    const proc = Bun.spawnSync([ffmpeg, ...buildNvencProbeArgs({ codec, gpu })], { stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export interface ResolvedCodec {
  /** The codec to actually encode with. */
  codec: Codec;
  /** A human-readable note when the request was changed, else null. */
  note: string | null;
}

/**
 * Resolve the codec to encode with. A CPU codec is used as-is. An NVENC codec is
 * probed once; if the probe fails (no NVENC, driver/session issue) it falls back
 * to its CPU sibling so the job still completes.
 */
export function resolveEncodeCodec(codec: Codec, ffmpeg: string, gpu?: number): ResolvedCodec {
  if (!isNvenc(codec)) return { codec, note: null };
  if (probeNvenc(ffmpeg, codec, gpu)) return { codec, note: null };
  const cpu = cpuSiblingCodec(codec);
  return { codec: cpu, note: `${codec} is not available on this machine; encoding with ${cpu} (CPU) instead` };
}
