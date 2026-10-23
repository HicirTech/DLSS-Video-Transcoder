import { Alert, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { FFMPEG_SUPPLY_HINT, type ToolsReport } from "../../../src/server/api-types";
import { Mono } from "./Mono";

/** What the NVENC chip measures and what it leaves to each job: ToolsReport.nvenc only says that ffmpeg lists the encoder. */
const NVENC_CHIP_HELP =
  "Whether this ffmpeg build lists the h264_nvenc encoder. It does not test your GPU, hevc_nvenc or av1_nvenc: each job test-encodes one frame with its own codec on its own GPU and falls back to the CPU codec when that fails.";

/** Whether the ffmpeg and ffprobe a video job needs were found, from GET /api/tools. */
export function ToolsBanner({ tools, toolsError }: { tools: ToolsReport | null; toolsError: string | null }) {
  if (toolsError) {
    return (
      <Alert severity="info" variant="outlined" role="status">
        Could not check for ffmpeg and ffprobe ({toolsError}), so whether video jobs can run is unknown. The check runs
        again when the page reconnects to the server; reload the page to run it now.
      </Alert>
    );
  }
  if (!tools) return null;
  const missing = [...(tools.ffmpeg.path === null ? ["ffmpeg"] : []), ...(tools.ffprobe.path === null ? ["ffprobe"] : [])];
  if (missing.length > 0) {
    return (
      <Alert severity="warning">
        {missing.join(" and ")} {missing.length === 1 ? "was" : "were"} not found on this machine. Video jobs need ffmpeg to
        decode frames and encode the result and ffprobe to read the source, so they will fail until both are found:{" "}
        {FFMPEG_SUPPLY_HINT}.
      </Alert>
    );
  }
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
      <Chip label={`ffmpeg ${tools.ffmpeg.version ?? ""}`.trim()} color="success" variant="outlined" />
      <Chip label={`ffprobe ${tools.ffprobe.version ?? ""}`.trim()} color="success" variant="outlined" />
      <Tooltip title={NVENC_CHIP_HELP} describeChild>
        <Chip
          tabIndex={0}
          label={tools.nvenc === null ? "NVENC build unknown" : tools.nvenc ? "ffmpeg built with NVENC" : "ffmpeg built without NVENC"}
          color={tools.nvenc ? "success" : "default"}
          variant="outlined"
        />
      </Tooltip>
      <Typography variant="caption" color="text.secondary">
        <Mono dim>{tools.ffmpeg.path}</Mono>
      </Typography>
    </Stack>
  );
}
