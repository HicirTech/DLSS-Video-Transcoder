/** GET /api/media: what a job would read from a file, read before the job runs so a form can show it and plan sizes. */
import { isPng, PNG_HEADER_BYTES, readPngHeader } from "../codec/png/chunks.ts";
import { requireFfmpegTools } from "../pipeline/tools.ts";
import { probeVideoAsync } from "../pipeline/video-probe.ts";
import type { MediaInfo } from "./api-types.ts";

/** A PNG's size, or what a video job reads from a video: its decoded size, rates, length, codec and audio. */
export async function mediaInfo(path: string): Promise<MediaInfo> {
  const head = new Uint8Array(await Bun.file(path).slice(0, PNG_HEADER_BYTES).arrayBuffer());
  if (isPng(head)) {
    const { width, height } = readPngHeader(head);
    return { kind: "image", width, height };
  }
  const { ffmpeg, ffprobe } = requireFfmpegTools("reading a video's size and rate");
  // The probe a video job runs, so the form plans with the size and rate the job will use; asynchronous, since this runs on the server's thread.
  const info = await probeVideoAsync(ffprobe, path, ffmpeg);
  return {
    kind: "video",
    width: info.width,
    height: info.height,
    fps: info.fpsText,
    nominalFps: info.nominalFpsText,
    frames: info.frames,
    durationSeconds: info.duration,
    codec: info.codec,
    hasAudio: info.hasAudio,
  };
}
