/**
 * The ffmpeg argv the video paths build: the output-side encoder for the rawvideo sinks, and the
 * display-aspect flags every output carries.
 */
import { clampToRange, ENCODE_CODECS, type EncodeSettings } from "../server/api-types.ts";
import { nvencGpuArgs } from "./encode-select.ts";
import { NVENC_PRESET } from "./nvenc.ts";
import { ratMul, type Rational, rational } from "./rational.ts";

/**
 * ffmpeg's output-side encoder argv for the rawvideo sinks. `cudaOrdinal` pins
 * the NVENC encoders to the job's CUDA device (the renderer's, see
 * GpuSession.cudaOrdinal); the CPU codecs ignore it.
 */
export function encoderArgs(encode: EncodeSettings, cudaOrdinal: number): string[] {
  const q = String(clampToRange("quality", encode.quality));
  const gpu = nvencGpuArgs(cudaOrdinal);
  switch (encode.codec) {
    case "h264":
      return ["-c:v", "libx264", "-preset", "medium", "-crf", q, "-pix_fmt", "yuv420p"];
    case "hevc":
      return ["-c:v", "libx265", "-preset", "medium", "-crf", q, "-pix_fmt", "yuv420p", "-tag:v", "hvc1"];
    case "av1":
      return ["-c:v", "libsvtav1", "-preset", "6", "-crf", q, "-pix_fmt", "yuv420p"];
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", ...gpu, "-preset", NVENC_PRESET, "-rc", "vbr", "-cq", q, "-b:v", "0", "-pix_fmt", "yuv420p"];
    case "hevc_nvenc":
      return ["-c:v", "hevc_nvenc", ...gpu, "-preset", NVENC_PRESET, "-rc", "vbr", "-cq", q, "-b:v", "0", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"];
    case "av1_nvenc":
      return ["-c:v", "av1_nvenc", ...gpu, "-preset", NVENC_PRESET, "-rc", "vbr", "-cq", q, "-b:v", "0", "-pix_fmt", "yuv420p"];
    default:
      throw new Error(`Unknown codec "${String(encode.codec)}". Choose one of: ${ENCODE_CODECS.join(", ")}.`);
  }
}

/**
 * Output argv that re-states the source's display aspect on a `width`x`height`
 * encode; empty for a square-pixel source, so the usual file is untouched.
 *
 * `demux` non-null means the video is stream-copied from an elementary stream,
 * which needs BOTH flags. -aspect writes the container tag, but with -c:v copy
 * ffmpeg tags the container from stream parameters it read before any filter
 * ran, so the aspect inside the bitstream would still claim 1:1. Measured with
 * the bundled ffmpeg: -aspect alone leaves the VUI at 1:1, the bitstream filter
 * alone leaves the container at 1:1, the pair agrees everywhere.
 */
export function aspectArgs(displayAspect: Rational | null, width: number, height: number, demux: string | null): string[] {
  if (!displayAspect) return [];
  const args = ["-aspect", `${displayAspect.num}:${displayAspect.den}`];
  if (!demux) return args;
  // The bitstream stores SAR: the sample shape that makes this pixel grid display at DAR.
  const sar = ratMul(displayAspect, rational(height, width));
  return [...args, "-bsf:v", `${demux}_metadata=sample_aspect_ratio=${sar.num}/${sar.den}`];
}
