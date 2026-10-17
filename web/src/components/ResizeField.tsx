import { Box, Stack, Typography } from "@mui/material";
import type { ScaleSettings } from "../../../src/server/api-types";
import { outputSizeLimits } from "../../../src/server/output-size";
import { type FrameSize, formatSize } from "../job-plan";
import { ScaleSettingsEditor } from "./ScaleSettingsEditor";

interface ResizeFieldProps {
  value: ScaleSettings;
  /** How the job resizes, in words: "lanczos, in the decode" for a video, "bilinear" for a still. */
  method: string;
  /** Why the job takes no resize (unusedSettings(job).resize), or null while it does. */
  unusedReason: string | null;
  /** The size the job writes, once the source's is known. */
  outputSize: FrameSize | null;
  onChange: (next: ScaleSettings) => void;
}

/**
 * The Output card's resize, offered only while Super Resolution is off: with it on, Super Resolution's card sets the
 * size, so this states that size and why rather than show a second size editor beside the first.
 */
export function ResizeField({ value, method, unusedReason, outputSize, onChange }: ResizeFieldProps) {
  if (unusedReason !== null) {
    return (
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Output size
        </Typography>
        {outputSize ? <Typography variant="body2">{formatSize(outputSize)}</Typography> : null}
        <Typography variant="caption" color="text.secondary">
          {unusedReason}
        </Typography>
      </Stack>
    );
  }
  return (
    <Box>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "baseline", flexWrap: "wrap", mb: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Resize
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {method}
        </Typography>
      </Stack>
      <ScaleSettingsEditor label="Resize to" value={value} limits={outputSizeLimits("resize")} onChange={onChange} />
    </Box>
  );
}
