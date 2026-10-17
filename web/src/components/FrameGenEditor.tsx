import { useId } from "react";
import { FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { FRAME_GEN_ENGINES, FRAME_GEN_FPS_CHOICES, FRAME_GEN_NATIVE_MAXIMUM, type FrameGenEngine, type FrameGenFps, SETTING_RANGES } from "../../../src/server/api-types";
import { formatFps } from "../format";
import type { StoredFrameGen } from "../hooks/useSettings";
import { NumberField } from "./NumberField";

// Record<...>: a path the API accepts without menu words is a build error, not a blank item.
const PATH_LABELS: Record<FrameGenEngine, string> = {
  auto: "Auto (native when possible, else cascade)",
  native: "Native DLSSG (exact integer ratios)",
  cascade: "Cascade of 2× stages",
};

interface FrameGenEditorProps {
  value: StoredFrameGen;
  /** The source's nominal rate, which frame generation plans on, once it is known. */
  sourceFps: number | null;
  /** The output rate these settings give (frameGenOutputFps), once it is known. */
  outputFps: number | null;
  onChange: (next: StoredFrameGen) => void;
}

/** Frame generation's output rate, given as a named rate or a multiple of the source's, and its path. */
export function FrameGenEditor({ value, sourceFps, outputFps, onChange }: FrameGenEditorProps) {
  const fpsLabelId = useId();
  const pathLabelId = useId();
  const update = (patch: Partial<StoredFrameGen>): void => onChange({ ...value, ...patch });
  const { min, max } = SETTING_RANGES.multiplier;
  const multiplied = sourceFps !== null && outputFps !== null ? `: ${formatFps(sourceFps)} → ${formatFps(outputFps)} fps` : "";

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
            helperText={`${min}–${max}× the source rate${multiplied}.`}
            sx={{ width: 240 }}
            onChange={(multiplier) => update({ multiplier })}
          />
        )}
        <FormControl sx={{ minWidth: 300 }}>
          <InputLabel id={pathLabelId}>Path</InputLabel>
          <Select<FrameGenEngine> labelId={pathLabelId} label="Path" value={value.engine} onChange={(event) => update({ engine: event.target.value as FrameGenEngine })}>
            {FRAME_GEN_ENGINES.map((mode) => (
              <MenuItem key={mode} value={mode}>
                {PATH_LABELS[mode]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>
      <FormHelperText>
        DLSS Frame Generation runs last, on the frames the steps before it made, and keeps the source duration; a rate
        at or below the source's generates nothing and only resamples. Path Auto runs one native DLSSG session when
        output ÷ source is an exact integer the runtime supports ({FRAME_GEN_NATIVE_MAXIMUM}) and, from 3× up,
        hardware-accelerated GPU scheduling (HAGS) is on; otherwise it chains 2× stages in memory (1 stage for 2×, 2
        for 4×, else 3 on an 8× grid) and places the nearest frame on each output instant. When the runtime generates
        nothing in a native multi-frame session, Auto falls back to the cascade by itself. Always writes MP4.
      </FormHelperText>
    </Stack>
  );
}
