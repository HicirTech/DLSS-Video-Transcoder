import { Chip, Stack, Typography } from "@mui/material";
import type { MediaInfo } from "../../../src/server/api-types";
import { formatDuration, formatFps, rateValue } from "../format";
import type { MediaState } from "../hooks/useMediaInfo";
import { formatSize } from "../job-plan";

interface MediaSummaryProps {
  media: MediaState;
  /** What the tab's jobs read: a PNG, or a video. */
  expected: MediaInfo["kind"];
}

/** What a tab says about a file its jobs do not read; a Record, so a kind without words is a build error. */
const WRONG_KIND: Record<MediaInfo["kind"], string> = {
  image: "This file is not a PNG, and image jobs take PNG only: convert it to PNG first.",
  video: "This is a PNG image: a video job would turn it into a one-frame video. The Image tab processes stills.",
};

/** The source's facts from GET /api/media, under the input field: what the form works its plan out from. */
export function MediaSummary({ media, expected }: MediaSummaryProps) {
  if (media.path === "") return null;
  if (media.loading) {
    return (
      <Typography variant="caption" color="text.secondary">
        Reading the file…
      </Typography>
    );
  }
  if (media.error !== null) {
    return (
      <Typography variant="caption" color="warning.main">
        Could not read the file: {media.error}
      </Typography>
    );
  }
  const info = media.info;
  if (info === null) return null;
  if (info.kind !== expected) {
    return (
      <Typography variant="caption" color="warning.main">
        {WRONG_KIND[expected]}
      </Typography>
    );
  }
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      {facts(info).map((fact) => (
        <Chip key={fact} size="small" variant="outlined" label={fact} />
      ))}
    </Stack>
  );
}

/** The facts worth knowing before a job runs, in words: size, and for a video its rates, length, frames, codec and audio. */
function facts(info: MediaInfo): string[] {
  if (info.kind === "image") return ["PNG", formatSize(info)];
  const nominal = rateValue(info.nominalFps);
  const average = rateValue(info.fps);
  const rates =
    nominal === null || average === null
      ? [`${info.fps} fps`]
      : formatFps(nominal) === formatFps(average)
        ? [`${formatFps(nominal)} fps`]
        : [`${formatFps(nominal)} fps nominal`, `${formatFps(average)} fps average`];
  return [
    formatSize(info),
    ...rates,
    ...(info.durationSeconds !== null ? [formatDuration(info.durationSeconds * 1000)] : []),
    ...(info.frames !== null ? [`${info.frames} frames`] : []),
    info.codec,
    info.hasAudio ? "audio" : "no audio",
  ];
}
