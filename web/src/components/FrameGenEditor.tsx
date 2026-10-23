import { useId } from "react";
import { FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack, ToggleButton, ToggleButtonGroup } from "@mui/material";
import {
  DEFAULT_FRAME_GEN_MULTIPLIER,
  FRAME_GEN_AUTO_PATH,
  FRAME_GEN_ENGINES,
  FRAME_GEN_FPS_CHOICES,
  type FrameGenEngine,
  type FrameGenFps,
  SETTING_RANGES,
} from "../../../src/server/api-types";
import type { StoredFrameGen } from "../stored-settings";
import { NumberField } from "./NumberField";

// Record<...>: a path the API accepts without menu words is a build error, not a blank item.
const PATH_LABELS: Record<FrameGenEngine, string> = {
  auto: "Auto (native when possible, else cascade)",
  native: "Native DLSSG (exact integer ratios)",
  cascade: "Cascade of 2× stages",
};

interface FrameGenEditorProps {
  value: StoredFrameGen;
  onChange: (next: StoredFrameGen) => void;
}

/** Frame generation's output rate, given as a named rate or a multiple of the source's, and its path. */
export function FrameGenEditor({ value, onChange }: FrameGenEditorProps) {
  const fpsLabelId = useId();
  const pathLabelId = useId();
  const helpId = useId();
  const update = (patch: Partial<StoredFrameGen>): void => onChange({ ...value, ...patch });
  const { min, max } = SETTING_RANGES.multiplier;

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={value.rateBy}
          aria-label="How the output rate is given"
          sx={{ mt: 1 }}
          onChange={(_event, rateBy: StoredFrameGen["rateBy"] | null) => {
            if (rateBy !== null) update({ rateBy });
          }}
        >
          <ToggleButton value="fps">Frame rate</ToggleButton>
          <ToggleButton value="multiplier">Multiple of the source</ToggleButton>
        </ToggleButtonGroup>
        {value.rateBy === "fps" ? (
          <FormControl sx={{ minWidth: 180 }}>
            <InputLabel id={fpsLabelId}>Output frame rate</InputLabel>
            <Select<FrameGenFps>
              labelId={fpsLabelId}
              label="Output frame rate"
              value={value.targetFps}
              onChange={(event) => update({ targetFps: event.target.value as FrameGenFps })}
            >
              {FRAME_GEN_FPS_CHOICES.map((fps) => (
                <MenuItem key={fps} value={fps}>
                  {fps} fps
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : (
          <NumberField
            label="Multiplier"
            value={value.multiplier}
            min={min}
            max={max}
            step={1}
            integer
            helperText={`${min}–${max}× the source rate. Default ${DEFAULT_FRAME_GEN_MULTIPLIER}×.`}
            sx={{ width: 240 }}
            onChange={(multiplier) => update({ multiplier })}
          />
        )}
        <FormControl sx={{ minWidth: 300 }}>
          <InputLabel id={pathLabelId}>Path</InputLabel>
          <Select<FrameGenEngine>
            labelId={pathLabelId}
            label="Path"
            value={value.engine}
            aria-describedby={helpId}
            onChange={(event) => update({ engine: event.target.value })}
          >
            {FRAME_GEN_ENGINES.map((mode) => (
              <MenuItem key={mode} value={mode}>
                {PATH_LABELS[mode]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>
      <FormHelperText id={helpId}>
        DLSS Frame Generation runs last, on the frames the steps before it made, and keeps the source duration; a rate
        at or below the source's generates nothing and only resamples. Path Auto: {FRAME_GEN_AUTO_PATH}. Always writes
        MP4.
      </FormHelperText>
    </Stack>
  );
}
