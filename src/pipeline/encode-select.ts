/**
 * Codec selection for the video and frame-generation encode paths: an NVENC
 * codec that cannot actually run on this machine degrades to its CPU sibling
 * rather than failing the job. Owns the ffmpeg-side NVENC vocabulary, which is
 * encoder NAMES ("h264_nvenc"); the in-process SDK's own codec list lives in
 * nvenc.ts and is a different set.
 */
import type { EncodeSettings } from "../server/api-types.ts";
import { nvencLimitExceeded } from "../server/output-size.ts";
import type { NvencSdkCodec } from "./nvenc.ts";

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

/**
 * Whether frames can be encoded in-process on the GPU (nvenc.ts) so ffmpeg only
 * muxes the compressed elementary stream, instead of an uncompressed rawvideo
 * pipe plus swscale. Null means take the rawvideo path.
 *
 * The gates are NVENC's own limits: 4:2:0 needs even dimensions, and the
 * encoder caps the frame size per codec (NVENC_MAX_SIDE, measured). av1_nvenc
 * falls through to null: nvenc.ts's CODEC_GUID only carries the H.264 and HEVC
 * GUIDs, so there is no in-process AV1 encoder.
 */
export function nvencNativeTarget(codec: Codec, width: number, height: number): { codec: NvencSdkCodec; demux: string } | null {
  if (width % 2 !== 0 || height % 2 !== 0) return null;
  if (nvencLimitExceeded(codec, { width, height }) !== null) return null;
  if (codec === "h264_nvenc") return { codec: "h264", demux: "h264" };
  if (codec === "hevc_nvenc") return { codec: "hevc", demux: "hevc" };
  return null;
}

/**
 * The argv that pins an ffmpeg NVENC encoder to a CUDA device. `gpu` is a CUDA
 * device ordinal (ffmpeg's -gpu counts CUDA devices), never a DXGI adapter
 * index: video jobs pass GpuSession.cudaOrdinal, frame generation
 * FRAMEGEN_CUDA_DEVICE. Shared by the availability probe and the encode argv so
 * the two can never name different devices; there is no unpinned form, since a
 * CUDA device is a requirement of every job.
 */
export function nvencGpuArgs(gpu: number): string[] {
  return ["-gpu", String(gpu)];
}

/**
 * ffmpeg args for a one-frame lavfi encode to `-f null`. The probe has to
 * actually encode: NVENC failures surface at session open, not from
 * `-encoders` listing the name. 256x256 only proves the encoder exists — the
 * per-codec size caps are NVENC_MAX_SIDE's, which resolveEncodeCodec checks
 * first. Success == exit 0.
 */
export function buildNvencProbeArgs(codec: FfmpegNvencEncoder, gpu: number): string[] {
  return ["-v", "error", "-f", "lavfi", "-i", "color=size=256x256:rate=1", "-frames:v", "1", "-c:v", codec, ...nvencGpuArgs(gpu), "-f", "null", "-"];
}

/**
 * Whether ffmpeg can really encode with this NVENC encoder here and now.
 * Named for the mechanism because nvenc.ts has its own probeNvencCaps that asks
 * the SDK directly over FFI; this one spawns ffmpeg, synchronously.
 */
export function probeNvencViaFfmpeg(ffmpeg: string, codec: FfmpegNvencEncoder, gpu: number): boolean {
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
 * Resolve the codec to encode `size` frames with: a CPU codec as-is, an NVENC
 * codec only if `size` is within its NVENC_MAX_SIDE and a probe run succeeds
 * here and now. Past that size NVENC refuses to open, which ffmpeg reports only
 * as a broken pipe once the frames start, so the CPU sibling takes it from the
 * start. The probe costs one ffmpeg spawn per call, so callers resolve once per
 * job and pass the result down.
 */
export function resolveEncodeCodec(codec: Codec, ffmpeg: string, gpu: number, size: { width: number; height: number }): ResolvedCodec {
  if (!isNvenc(codec)) return { codec, note: null };
  const cpu = cpuSiblingCodec(codec);
  const limit = nvencLimitExceeded(codec, size);
  if (limit !== null) {
    const onGpu = FFMPEG_NVENC_ENCODERS.filter((other) => nvencLimitExceeded(other, size) === null);
    const instead = onGpu.length ? `; ${onGpu.join(" or ")} would keep it on the GPU` : "";
    return { codec: cpu, note: `${codec} encodes at most ${limit} pixels per side and this output is ${size.width}x${size.height}: encoding with ${cpu} (CPU) instead, which is slower${instead}` };
  }
  if (probeNvencViaFfmpeg(ffmpeg, codec, gpu)) return { codec, note: null };
  return { codec: cpu, note: `${codec} is not available on this machine; encoding with ${cpu} (CPU) instead` };
}
