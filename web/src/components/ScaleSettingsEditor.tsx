import { useId } from "react";
import { FormControl, InputLabel, MenuItem, Select, Stack } from "@mui/material";
import type { ScaleSettings } from "../../../src/server/api-types";
import { NumberField } from "./NumberField";

interface ScaleSettingsEditorProps {
  value: ScaleSettings;
  onChange: (next: ScaleSettings) => void;
}

export function ScaleSettingsEditor({ value, onChange }: ScaleSettingsEditorProps) {
  // useId, not a constant: every tab stays mounted, so two panels can render
  // this component at once and a fixed id would appear twice in one document.
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
          <MenuItem value="none">None — keep source size</MenuItem>
          <MenuItem value="factor">Multiply by a factor</MenuItem>
          <MenuItem value="size">Set exact width × height</MenuItem>
        </Select>
      </FormControl>
      {value.mode === "factor" ? (
        <NumberField
          label="Factor"
          value={value.factor}
          min={0.25}
          max={8}
          step={0.25}
          helperText="Multiplies source resolution. 0.25–8×, default 1.5×."
          sx={{ width: 200 }}
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
            helperText="Output width in pixels (16–16384). Default 1920."
            sx={{ width: 220 }}
            onChange={(width) => update({ width })}
          />
          <NumberField
            label="Height"
            value={value.height}
            min={16}
            max={16384}
            step={16}
            integer
            helperText="Output height in pixels (16–16384). Default 1080."
            sx={{ width: 220 }}
            onChange={(height) => update({ height })}
          />
        </>
      ) : null}
    </Stack>
  );
}
