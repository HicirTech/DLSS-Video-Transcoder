/**
 * Codec selection for the video and frame-generation encode paths: an NVENC
 * codec that cannot actually run on this machine degrades to its CPU sibling
 * rather than failing the job.
 */
import type { EncodeSettings } from "../server/api-types.ts";
import { NVENC_CODECS, type NvencCodec, buildNvencProbeArgs } from "./nut.ts";

export type Codec = EncodeSettings["codec"];

const NVENC_SET: ReadonlySet<string> = new Set(NVENC_CODECS);

export function isNvenc(codec: string): codec is NvencCodec {
  return NVENC_SET.has(codec);
}

/** Each NVENC encoder mapped to the CPU codec producing the same bitstream format. */
const NVENC_TO_CPU_CODEC: Record<NvencCodec, Codec> = {
  h264_nvenc: "h264",
  hevc_nvenc: "hevc",
  av1_nvenc: "av1",
};

/** The CPU sibling for an NVENC codec; a CPU codec passes through unchanged. */
export function cpuSiblingCodec(codec: Codec): Codec {
  return isNvenc(codec) ? NVENC_TO_CPU_CODEC[codec] : codec;
}

/** Default when the caller expressed no preference: H.264 either way, GPU if it is there. */
export function preferredDefaultCodec(nvencAvailable: boolean): Codec {
  return nvencAvailable ? "h264_nvenc" : "h264";
}

/**
 * Run nut.ts's one-frame NVENC probe. True only if the encoder really produced
 * a frame: a driver or session failure still leaves the encoder name listed by
 * ffmpeg, so nothing short of encoding proves it works. Spawns synchronously.
 */
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
 * Resolve the codec to encode with: a CPU codec as-is, an NVENC codec only if a
 * probe run succeeds here and now. The probe costs one ffmpeg spawn per call,
 * so callers resolve once per job and pass the result down.
 */
export function resolveEncodeCodec(codec: Codec, ffmpeg: string, gpu?: number): ResolvedCodec {
  if (!isNvenc(codec)) return { codec, note: null };
  if (probeNvenc(ffmpeg, codec, gpu)) return { codec, note: null };
  const cpu = cpuSiblingCodec(codec);
  return { codec: cpu, note: `${codec} is not available on this machine; encoding with ${cpu} (CPU) instead` };
}
