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

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * ffmpeg argv (after the binary) that decodes the first video stream to raw RGBA frames of `output` size
 * on pipe:1, scaling with lanczos only when that differs from the `source` size.
 */
export function decodeArgv(spec: { input: string; source: FrameSize; output: FrameSize }): string[] {
  const { input, source, output } = spec;
  const rescaled = output.width !== source.width || output.height !== source.height;
  return [
    "-v", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba",
    ...(rescaled ? ["-vf", `scale=${output.width}:${output.height}:flags=lanczos`] : []),
    "pipe:1",
  ];
}

/**
 * The output flags for the audio: the first audio track of input 1 (the source file, opened a
 * second time only when its audio is carried over) copied for mkv and re-encoded to AAC 192 kb/s
 * for the other containers, or no audio at all.
 */
export function audioArgs(carryAudio: boolean, container: EncodeSettings["container"]): string[] {
  if (!carryAudio) return ["-an"];
  return ["-map", "1:a:0", ...(container === "mkv" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"])];
}

/** mp4 and mov take +faststart, which moves the index to the front so the file plays before it has downloaded; mkv has no such flag. */
export function faststartArgs(container: EncodeSettings["container"]): string[] {
  return container === "mp4" || container === "mov" ? ["-movflags", "+faststart"] : [];
}

export interface MuxCopySpec {
  /** ffmpeg demuxer for the elementary stream on stdin ("h264" or "hevc"): NVENC's output has no container. */
  demux: string;
  /** The rate to stamp on the stream, which carries no timing of its own. */
  frameRate: string;
  /** The file whose first audio track is carried over, or null for no audio. */
  audioSource: string | null;
  container: EncodeSettings["container"];
  displayAspect: Rational | null;
  size: FrameSize;
  /** Output flags that come after the audio ones and before the container's own, such as -video_track_timescale. */
  extra?: readonly string[];
  output: string;
}

/**
 * ffmpeg argv that muxes NVENC's elementary stream (pipe:0, input 0) into the output without
 * re-encoding. The stream is Annex-B with no timing at all, so -framerate is the only thing that
 * lets the muxer stamp timestamps; mp4 and mov convert it to length-prefixed themselves, so `copy`
 * needs no bitstream filter. The audio source, when there is one, is input 1. No -shortest: with -c:v copy from a
 * raw elementary stream it drops the audio track outright, and it is safe to leave out because every
 * path using this emits one frame per source frame (or covers the decoded length), so audio and
 * video share a duration.
 */
export function muxCopyArgs(spec: MuxCopySpec): string[] {
  const { demux, frameRate, audioSource, container, displayAspect, size, extra = [], output } = spec;
  return [
    "-v", "error", "-y", "-f", demux, "-framerate", frameRate, "-i", "pipe:0",
    ...(audioSource === null ? [] : ["-i", audioSource]),
    "-map", "0:v:0", "-c:v", "copy",
    ...aspectArgs(displayAspect, size.width, size.height, demux),
    ...audioArgs(audioSource !== null, container),
    ...extra, ...faststartArgs(container), output,
  ];
}
