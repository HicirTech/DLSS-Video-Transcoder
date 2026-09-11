/**
 * Codec selection for the video and frame-generation encode paths: an NVENC
 * codec that cannot actually run on this machine degrades to its CPU sibling
 * rather than failing the job. Owns the ffmpeg-side NVENC vocabulary, which is
 * encoder NAMES ("h264_nvenc"); the in-process SDK's own codec list lives in
 * nvenc.ts and is a different set.
 */
import type { EncodeSettings } from "../server/api-types.ts";

export type Codec = EncodeSettings["codec"];

/** The NVENC encoders ffmpeg exposes. Order matches EncodeSettings["codec"] in api-types.ts. */
export const FFMPEG_NVENC_ENCODERS = ["h264_nvenc", "hevc_nvenc", "av1_nvenc"] as const;
export type FfmpegNvencEncoder = (typeof FFMPEG_NVENC_ENCODERS)[number];

const NVENC_SET: ReadonlySet<string> = new Set(FFMPEG_NVENC_ENCODERS);

export function isNvenc(codec: string): codec is FfmpegNvencEncoder {
  return NVENC_SET.has(codec);
}

/** Each NVENC encoder mapped to the CPU codec producing the same bitstream format. */
const NVENC_TO_CPU_CODEC: Record<FfmpegNvencEncoder, Codec> = {
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
 * ffmpeg args for a one-frame lavfi encode to `-f null`. The probe has to
 * actually encode: NVENC failures surface at session open, not from
 * `-encoders` listing the name. 256x256 only proves the encoder exists — the
 * per-codec size caps are checked separately in video.ts. Success == exit 0.
 *
 * `gpu` is a CUDA device ordinal (ffmpeg's -gpu counts CUDA devices), never a
 * DXGI adapter index: callers pass GpuSession.cudaOrdinal.
 */
export function buildNvencProbeArgs(codec: FfmpegNvencEncoder, gpu?: number): string[] {
  const args = ["-v", "error", "-f", "lavfi", "-i", "color=size=256x256:rate=1", "-frames:v", "1", "-c:v", codec];
  if (gpu !== undefined) args.push("-gpu", String(gpu));
  args.push("-f", "null", "-");
  return args;
}

/**
 * Whether ffmpeg can really encode with this NVENC encoder here and now.
 * Named for the mechanism because nvenc.ts has its own probeNvencCaps that asks
 * the SDK directly over FFI; this one spawns ffmpeg, synchronously.
 */
export function probeNvencViaFfmpeg(ffmpeg: string, codec: FfmpegNvencEncoder, gpu?: number): boolean {
  try {
    const proc = Bun.spawnSync([ffmpeg, ...buildNvencProbeArgs(codec, gpu)], { stdout: "ignore", stderr: "ignore" });
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
  if (probeNvencViaFfmpeg(ffmpeg, codec, gpu)) return { codec, note: null };
  const cpu = cpuSiblingCodec(codec);
  return { codec: cpu, note: `${codec} is not available on this machine; encoding with ${cpu} (CPU) instead` };
}
