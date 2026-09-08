import { FormControl, InputLabel, MenuItem, Select, Stack } from "@mui/material";
import type { ScaleSettings } from "../../../src/server/api-types";
import { NumberField } from "./NumberField";

interface ScaleSettingsEditorProps {
  value: ScaleSettings;
  onChange: (next: ScaleSettings) => void;
}

export function ScaleSettingsEditor({ value, onChange }: ScaleSettingsEditorProps) {
  const update = (patch: Partial<ScaleSettings>): void => onChange({ ...value, ...patch });

  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <FormControl sx={{ minWidth: 200 }}>
        <InputLabel id="scale-mode-label">Output size</InputLabel>
        <Select<ScaleSettings["mode"]>
          labelId="scale-mode-label"
          label="Output size"
          value={value.mode}
          onChange={(event) => update({ mode: event.target.value })}
        >
          <MenuItem value="none">Keep source size</MenuItem>
          <MenuItem value="factor">Multiply by factor</MenuItem>
          <MenuItem value="size">Explicit size</MenuItem>
        </Select>
      </FormControl>
      {value.mode === "factor" ? (
        <NumberField
          label="Factor"
          value={value.factor}
          min={0.25}
          max={8}
          step={0.25}
          sx={{ width: 140 }}
          onChange={(factor) => update({ factor })}
        />
      ) : null}
      {value.mode === "size" ? (
        <>
          <NumberField
            label="Width"
            value={value.width}
            min={16}
            max={16384}
            step={16}
            integer
            sx={{ width: 140 }}
            onChange={(width) => update({ width })}
          />
          <NumberField
            label="Height"
            value={value.height}
            min={16}
            max={16384}
            step={16}
            integer
            sx={{ width: 140 }}
            onChange={(height) => update({ height })}
          />
        </>
      ) : null}
    </Stack>
  );
}
