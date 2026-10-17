import { Stack } from "@mui/material";
import { outputSizeLimits } from "../../../src/server/output-size";
import type { StoredSuperResolution } from "../hooks/useSettings";
import { MotionSelect } from "./JobFormFields";
import { ScaleSettingsEditor } from "./ScaleSettingsEditor";

interface SuperResolutionEditorProps {
  value: StoredSuperResolution;
  /** A video job also takes motion vectors; a still has no motion between frames. */
  kind: "image" | "video";
  onChange: (next: StoredSuperResolution) => void;
}

/** Super Resolution's output size, held to what DLSS SR writes, and for a video its motion vectors. */
export function SuperResolutionEditor({ value, kind, onChange }: SuperResolutionEditorProps) {
  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <ScaleSettingsEditor
        label="Upscale to"
        value={value.scale}
        limits={outputSizeLimits("sr")}
        noneLabel="Source size — DLAA, no upscale"
        onChange={(scale) => onChange({ ...value, scale })}
      />
      {kind === "video" ? <MotionSelect value={value.motion} onChange={(motion) => onChange({ ...value, motion })} /> : null}
    </Stack>
  );
}
