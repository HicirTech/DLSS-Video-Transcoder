/** What ffprobe says about a video, interpreted for the pipeline: display size after rotation, aspect, rates and audio. */
import { type Rational, ratToNumber, rational, tryParseRate } from "./rational.ts";

export interface VideoInfo {
  /** Display width: already transposed when the stream carries a 90/270 rotation. */
  width: number;
  height: number;
  /** Display-matrix rotation in degrees, 0 when the stream carries none. */
  rotation: number;
  /**
   * Display aspect ratio to re-state on the output; null when the source is
   * square-pixel or declares nothing, so there is nothing to restore. DAR rather
   * than the raw sample aspect because every path here rescales, and DAR is what
   * survives a rescale; ffmpeg's -aspect takes it directly.
   */
  displayAspect: Rational | null;
  fps: number;
  /** Measured average rate (avg_frame_rate) when available, else the nominal rate. */
  fpsText: string;
  /** Nominal stream rate (r_frame_rate): the exact CFR clock frame generation plans on. */
  nominalFpsText: string;
  frames: number | null;
  duration: number | null;
  codec: string;
  hasAudio: boolean;
}

/**
 * The rate string itself, or null when ffmpeg could not use it. Both rate
 * fields go through this: they are passed verbatim as `-framerate`/`-r`, and
 * ffmpeg rejects "0/0" outright ("Unable to parse ... as video rate") instead
 * of defaulting, so an unusable rate has to fall through to the numeric one.
 */
function rateText(text: string | undefined): string | null {
  return tryParseRate(text) ? (text ?? null) : null;
}

/** The rate assumed when ffprobe reports neither rate field as usable. */
const FALLBACK_FPS = 30;

/**
 * What the decode pipe will actually emit, read from the decoder rather than
 * predicted. ffprobe prints the display-matrix angle as a truncated integer
 * (89 for 89.99), while ffmpeg's autorotate decides from the full-precision
 * angle with a half-degree tolerance, so no arithmetic on the printed value can
 * reproduce its decision — a matrix in (89.5, 90.0) transposes on decode while
 * the integer says 89, and one in (90.5, 91.0) does not while it says 90.
 *
 * showinfo logs at INFO, so this call must not pass `-v error`. Costs one
 * ffmpeg start plus one frame (~65 ms here, next to the ~62 ms ffprobe already
 * spends), which is why the caller only pays it when a rotation is present.
 */
function decodedFrameSize(ffmpeg: string, input: string): { width: number; height: number } | null {
  const proc = Bun.spawnSync([ffmpeg, "-hide_banner", "-nostdin", "-i", input, "-map", "0:v:0", "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const shown = /\ss:(\d+)x(\d+)\s/.exec(new TextDecoder().decode(proc.stderr));
  if (!shown) return null;
  return { width: Number(shown[1]), height: Number(shown[2]) };
}

/**
 * `ffmpeg` is optional: it is only spawned when the stream carries a rotation,
 * to confirm the geometry the decoder will hand over. Without it a rotated
 * source falls back to the angle-based guess, which is right for every exact
 * 90/180/270 matrix — the case phone footage produces.
 */
export function probeVideo(ffprobe: string, input: string, ffmpeg?: string): VideoInfo {
  const proc = Bun.spawnSync(
    [
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,r_frame_rate,avg_frame_rate,nb_frames:stream_side_data=rotation:format=duration",
      "-of",
      "json",
      input,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) throw new Error(`ffprobe could not read this file as video: ${new TextDecoder().decode(proc.stderr).trim()}`);
  const info = videoInfoFrom(JSON.parse(new TextDecoder().decode(proc.stdout)) as ProbeJson, input);
  if (info.rotation === 0 || !ffmpeg) return info;
  const decoded = decodedFrameSize(ffmpeg, input);
  if (!decoded || (decoded.width === info.width && decoded.height === info.height)) return info;
  // The decoder disagreed with the angle. It is the one feeding the pipeline,
  // so its output size wins over one predicted from the rotation.
  return { ...info, width: decoded.width, height: decoded.height };
}

export interface ProbeJson {
  streams?: {
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    sample_aspect_ratio?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    nb_frames?: string;
    side_data_list?: { rotation?: number }[];
  }[];
  format?: { duration?: string };
}

/** Display-matrix rotation in degrees, normalised to (-180, 180]; 0 when the stream carries none. */
function rotationDegrees(sideData: { rotation?: number }[] | undefined): number {
  const raw = sideData?.find((s) => typeof s.rotation === "number")?.rotation;
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  const wrapped = ((Math.round(raw) % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * The display aspect ratio a non-square-pixel source must keep, from ffprobe's
 * sample_aspect_ratio ("8:9"; the field is absent for an mp4 with no pasp atom
 * — both measured). Null for 1:1, "0:1", "N/A" and a missing field, so a
 * square-pixel source adds no argv and its output is untouched. width/height
 * are the DISPLAY dimensions, already transposed for a 90/270 rotation; that
 * rotation turns the sample grid with the picture, so the sample aspect inverts
 * along with the geometry.
 */
function displayAspectOf(text: string | undefined, width: number, height: number, transposed: boolean): Rational | null {
  if (!text) return null;
  const [n, d] = text.split(":");
  const num = Number(n);
  const den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0 || num === den) return null;
  const [sarNum, sarDen] = transposed ? [den, num] : [num, den];
  return rational(sarNum * width, sarDen * height);
}

/** ffprobe's JSON as a VideoInfo. Separate from the spawn so it can be tested against odd streams. */
export function videoInfoFrom(data: ProbeJson, input: string): VideoInfo {
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error(`${input}: no video stream found in this file.`);
  const measured = tryParseRate(video.avg_frame_rate) ?? tryParseRate(video.r_frame_rate);
  const fps = measured ? ratToNumber(measured) : FALLBACK_FPS;
  const duration = data.format?.duration ? Number(data.format.duration) : null;
  const declared = video.nb_frames && video.nb_frames !== "N/A" ? Number(video.nb_frames) : null;
  // ffprobe reports the CODED size, but ffmpeg autorotates on decode, so a
  // portrait phone clip (coded 1920x1080, rotation 90) arrives as 1080x1920.
  // Report what the decoder emits: width*height is the same either way, so a
  // transposed frame reads as a whole frame and nothing downstream can notice.
  const rotation = rotationDegrees(video.side_data_list);
  const transposed = Math.abs(rotation) % 180 === 90;
  const displayWidth = transposed ? video.height : video.width;
  const displayHeight = transposed ? video.width : video.height;
  return {
    width: displayWidth,
    height: displayHeight,
    rotation,
    displayAspect: displayAspectOf(video.sample_aspect_ratio, displayWidth, displayHeight, transposed),
    fps,
    // Measured average first; the nominal CFR clock first for nominalFpsText.
    fpsText: rateText(video.avg_frame_rate) ?? rateText(video.r_frame_rate) ?? String(fps),
    nominalFpsText: rateText(video.r_frame_rate) ?? rateText(video.avg_frame_rate) ?? String(fps),
    frames: declared ?? (duration ? Math.round(duration * fps) : null),
    duration,
    codec: video.codec_name ?? "unknown",
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === "audio")),
  };
}
