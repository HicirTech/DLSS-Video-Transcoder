import { useId } from "react";
import { FormControl, InputLabel, MenuItem, Select, Stack } from "@mui/material";
import { DEFAULT_SCALE_SETTINGS, SCALE_MODES, SETTING_RANGES, type ScaleSettings } from "../../../src/server/api-types";
import { NumberField } from "./NumberField";

/** Menu words for each output-size mode; the Record makes a mode without words a build error. */
const MODE_LABELS: Record<ScaleSettings["mode"], string> = {
  none: "None — keep source size",
  factor: "Multiply by a factor",
  size: "Set exact width × height",
};

interface ScaleSettingsEditorProps {
  value: ScaleSettings;
  onChange: (next: ScaleSettings) => void;
}

export function ScaleSettingsEditor({ value, onChange }: ScaleSettingsEditorProps) {
  const modeLabelId = useId();
  const update = (patch: Partial<ScaleSettings>): void => onChange({ ...value, ...patch });

  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <FormControl sx={{ minWidth: 200 }}>
        <InputLabel id={modeLabelId}>Output size</InputLabel>
        <Select<ScaleSettings["mode"]>
          labelId={modeLabelId}
          label="Output size"
          value={value.mode}
          onChange={(event) => update({ mode: event.target.value })}
        >
          {SCALE_MODES.map((mode) => (
            <MenuItem key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      {value.mode === "factor" ? (
        <NumberField
          label="Factor"
          value={value.factor}
          {...SETTING_RANGES.factor}
          step={0.25}
          helperText={`Multiplies source resolution. ${SETTING_RANGES.factor.min}–${SETTING_RANGES.factor.max}×, default ${DEFAULT_SCALE_SETTINGS.factor}×.`}
          sx={{ width: 200 }}
          onChange={(factor) => update({ factor })}
        />
      ) : null}
      {value.mode === "size" ? (
        <>
          <NumberField
            label="Width"
            value={value.width}
            {...SETTING_RANGES.width}
            step={16}
            helperText={`Output width in pixels (${SETTING_RANGES.width.min}–${SETTING_RANGES.width.max}). Default ${DEFAULT_SCALE_SETTINGS.width}.`}
            sx={{ width: 220 }}
            onChange={(width) => update({ width })}
          />
          <NumberField
            label="Height"
            value={value.height}
            {...SETTING_RANGES.height}
            step={16}
            helperText={`Output height in pixels (${SETTING_RANGES.height.min}–${SETTING_RANGES.height.max}). Default ${DEFAULT_SCALE_SETTINGS.height}.`}
            sx={{ width: 220 }}
            onChange={(height) => update({ height })}
          />
        </>
      ) : null}
    </Stack>
  );
}
