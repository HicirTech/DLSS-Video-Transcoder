import { useId } from "react";
import { FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack } from "@mui/material";
import { MOTION_KINDS, type MotionKind } from "../../../src/server/api-types";
import { outputSizeLimits } from "../../../src/server/output-size";
import type { StoredSuperResolution } from "../stored-settings";
import { ScaleSettingsEditor } from "./ScaleSettingsEditor";

// Record<...>: a motion mode the API accepts without menu words is a build error, not a blank item.
const MOTION_MENU_LABELS: Record<MotionKind, string> = {
  none: "None — process each frame independently",
  flow: "Optical flow (estimate motion between frames)",
};

interface MotionSelectProps {
  value: MotionKind;
  onChange: (value: MotionKind) => void;
}

/** Super Resolution's motion mode for video jobs: each frame on its own, or with optical flow estimated between frames. */
function MotionSelect({ value, onChange }: MotionSelectProps) {
  const motionLabelId = useId();
  const motionHelpId = useId();
  return (
    <FormControl sx={{ minWidth: 260, maxWidth: 420 }}>
      <InputLabel id={motionLabelId}>Motion</InputLabel>
      <Select<MotionKind>
        labelId={motionLabelId}
        label="Motion"
        value={value}
        aria-describedby={motionHelpId}
        onChange={(event) => onChange(event.target.value)}
      >
        {MOTION_KINDS.map((motion) => (
          <MenuItem key={motion} value={motion}>
            {MOTION_MENU_LABELS[motion]}
          </MenuItem>
        ))}
      </Select>
      <FormHelperText id={motionHelpId}>
        Optical flow hands Super Resolution the motion between frames, for steadier detail over time: on the GPU's
        hardware flow engine (NVOFA) when it starts, otherwise a slower CPU estimator.
      </FormHelperText>
    </FormControl>
  );
}

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
