/**
 * The ffmpeg argv the video paths build: the output-side encoder for the rawvideo sinks, and the
 * display-aspect flags every output carries.
 */
import { AAC_KBPS, AUDIO_IN_CONTAINER, clampToRange, ENCODE_CODECS, type EncodeSettings } from "../server/api-types.ts";
import { nvencGpuArgs } from "./encode-select.ts";
import { NVENC_PRESET } from "./nvenc.ts";
import { ratMul, type Rational, rational } from "./rational.ts";

/**
 * ffmpeg's output-side encoder argv for the rawvideo sinks. `cudaOrdinal` pins
 * the NVENC encoders to the job's CUDA device (the renderer's, see
 * GpuSession.cudaOrdinal); the CPU codecs ignore it.
 */
export function encoderArgs(encode: EncodeSettings, cudaOrdinal: number): string[] {
  const hevc = encode.codec === "hevc" || encode.codec === "hevc_nvenc";
  // 4:2:0 for every codec, and the hvc1 tag so Apple players accept HEVC in mp4 and mov.
  return [...codecArgs(encode, cudaOrdinal), "-pix_fmt", "yuv420p", ...(hevc ? ["-tag:v", "hvc1"] : [])];
}

/** The encoder and its quality settings: what differs between the codecs. */
function codecArgs(encode: EncodeSettings, cudaOrdinal: number): string[] {
  const q = String(clampToRange("quality", encode.quality));
  switch (encode.codec) {
    case "h264":
      return ["-c:v", "libx264", "-preset", "medium", "-crf", q];
    case "hevc":
      return ["-c:v", "libx265", "-preset", "medium", "-crf", q];
    case "av1":
      return ["-c:v", "libsvtav1", "-preset", "6", "-crf", q];
    case "h264_nvenc":
    case "hevc_nvenc":
    case "av1_nvenc":
      return ["-c:v", encode.codec, ...nvencGpuArgs(cudaOrdinal), "-preset", NVENC_PRESET, "-rc", "vbr", "-cq", q, "-b:v", "0"];
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

interface FrameSize {
  width: number;
  height: number;
}

/**
 * ffmpeg argv (after the binary) that decodes the first video stream to raw RGBA frames of `output` size
 * on pipe:1, scaling with lanczos only when that differs from the `source` size.
 *
 * rawvideo output is constant-rate. Without `frameRate` ffmpeg resamples to the stream's nominal rate
 * (r_frame_rate), the clock frame generation plans on. A video job passes the rate it stamps its output
 * with: where a source's average rate is not its nominal one, a decode at the nominal rate drops frames
 * (3 of 2.mp4's 3737) and the stamped clock then plays everything after each drop a frame early, ahead of
 * the audio.
 */
export function decodeArgv(spec: { input: string; source: FrameSize; output: FrameSize; frameRate?: string }): string[] {
  const { input, source, output, frameRate } = spec;
  const rescaled = output.width !== source.width || output.height !== source.height;
  return [
    "-v", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba",
    ...(rescaled ? ["-vf", `scale=${output.width}:${output.height}:flags=lanczos`] : []),
    ...(frameRate === undefined ? [] : ["-fps_mode", "cfr", "-r", frameRate]),
    "pipe:1",
  ];
}

/**
 * The output flags for the audio: the first audio track of input 1 (the source file, opened a
 * second time only when its audio is carried over), copied or re-encoded to AAC as
 * AUDIO_IN_CONTAINER says for the container, or no audio at all.
 */
export function audioArgs(carryAudio: boolean, container: EncodeSettings["container"]): string[] {
  if (!carryAudio) return ["-an"];
  return ["-map", "1:a:0", ...(AUDIO_IN_CONTAINER[container] === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", `${AAC_KBPS}k`])];
}

/** mp4 and mov take +faststart, which moves the index to the front so the file plays before it has downloaded; mkv has no such flag. */
export function faststartArgs(container: EncodeSettings["container"]): string[] {
  return container === "mp4" || container === "mov" ? ["-movflags", "+faststart"] : [];
}

interface MuxCopySpec {
  /** ffmpeg demuxer for the elementary stream on stdin ("h264" or "hevc"): NVENC's output has no container. */
  demux: string;
  /** The rate to stamp on the stream, which carries no timing of its own. */
  frameRate: string;
  /** The file whose first audio track is carried over, or null for no audio. */
  audioSource: string | null;
  container: EncodeSettings["container"];
  displayAspect: Rational | null;
  size: FrameSize;
  /**
   * Re-stamps packet N at exactly N / `retime`, for an output whose clock has to be exact (frame generation's,
   * checked by verifyOutputVideo). The raw demuxer counts in 1/1200000 s and adds a rounded frame duration per
   * packet, so a rate that tick does not divide drifts: at 7508/125 one packet of 182 lands 124 ticks after the
   * last instead of 125. Exact while the rate's numerator is below those 1200000 ticks.
   */
  retime?: Rational;
  /** Output flags that come after the audio ones and before the container's own, such as -video_track_timescale. */
  extra?: readonly string[];
  output: string;
}

/**
 * The setts bitstream filter that stamps packet N at N / `rate`, its duration one frame. Its expressions are in
 * the input's time base (TB, the raw demuxer's), so each stamp is rounded once, from N rather than from the last
 * packet, and the muxer's rescale into the track's 1/num ticks then lands on N x den exactly. The time base
 * itself is left alone: the mp4 muxer derives the movie timescale from it, so a rate the demuxer already stamped
 * evenly writes the same bytes as without the filter.
 */
function retimeFilter(rate: Rational): string {
  const frame = `${rate.den}/(${rate.num}*TB)`;
  return `setts=ts=N*${frame}:duration=${frame}`;
}

/** `args` with `filter` chained onto their -bsf:v, or given one: a second -bsf:v would replace the first. */
function withBitstreamFilter(args: readonly string[], filter: string): string[] {
  const at = args.indexOf("-bsf:v");
  if (at < 0) return [...args, "-bsf:v", filter];
  return args.map((arg, index) => (index === at + 1 ? `${arg},${filter}` : arg));
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
  const { demux, frameRate, audioSource, container, displayAspect, size, retime, extra = [], output } = spec;
  const aspect = aspectArgs(displayAspect, size.width, size.height, demux);
  return [
    "-v", "error", "-y", "-f", demux, "-framerate", frameRate, "-i", "pipe:0",
    ...(audioSource === null ? [] : ["-i", audioSource]),
    "-map", "0:v:0", "-c:v", "copy",
    ...(retime ? withBitstreamFilter(aspect, retimeFilter(retime)) : aspect),
    ...audioArgs(audioSource !== null, container),
    ...extra, ...faststartArgs(container), output,
  ];
}
