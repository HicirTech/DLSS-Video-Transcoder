import { useId } from "react";
import { FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack } from "@mui/material";
import { DEFAULT_SCALE_SETTINGS, SCALE_MODES, SETTING_RANGES, type ScaleSettings } from "../../../src/server/api-types";
import type { OutputSizeLimits } from "../../../src/server/output-size";
import { NumberField } from "./NumberField";

/** Menu words for each output-size mode; the Record makes a mode without words a build error. */
const MODE_LABELS: Record<ScaleSettings["mode"], string> = {
  none: "None — keep source size",
  factor: "Multiply by a factor",
  size: "Set exact width × height",
};

interface ScaleSettingsEditorProps {
  /** What the size is for, as its menu is labelled: "Upscale to" in Super Resolution's card, "Resize to" for the resize. */
  label: string;
  value: ScaleSettings;
  /** What the step that sets the size can write (outputSizeLimits): the fields hold to it and a stored value outside it is marked. */
  limits: OutputSizeLimits;
  /** The menu words for mode none, when keeping the source size means more than that (Super Resolution runs DLAA). */
  noneLabel?: string;
  onChange: (next: ScaleSettings) => void;
}

export function ScaleSettingsEditor({ label, value, limits, noneLabel, onChange }: ScaleSettingsEditorProps) {
  const modeLabelId = useId();
  const update = (patch: Partial<ScaleSettings>): void => onChange({ ...value, ...patch });
  const factorMin = Math.max(SETTING_RANGES.factor.min, limits.factorMin ?? SETTING_RANGES.factor.min);
  const widthMax = Math.min(SETTING_RANGES.width.max, limits.sideMax ?? SETTING_RANGES.width.max);
  const heightMax = Math.min(SETTING_RANGES.height.max, limits.sideMax ?? SETTING_RANGES.height.max);
  // A value stored under wider limits can sit outside these until it is edited, which clamps it.
  const outside =
    (value.mode === "factor" && value.factor < factorMin) || (value.mode === "size" && (value.width > widthMax || value.height > heightMax));

  return (
    <Stack spacing={0.5}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
        <FormControl sx={{ minWidth: 200 }}>
          <InputLabel id={modeLabelId}>{label}</InputLabel>
          <Select<ScaleSettings["mode"]>
            labelId={modeLabelId}
            label={label}
            value={value.mode}
            onChange={(event) => update({ mode: event.target.value })}
          >
            {SCALE_MODES.map((mode) => (
              <MenuItem key={mode} value={mode}>
                {mode === "none" && noneLabel ? noneLabel : MODE_LABELS[mode]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {value.mode === "factor" ? (
          <NumberField
            label="Factor"
            value={value.factor}
            min={factorMin}
            max={SETTING_RANGES.factor.max}
            step={0.25}
            error={outside}
            helperText={`Multiplies source resolution. ${factorMin}–${SETTING_RANGES.factor.max}×, default ${DEFAULT_SCALE_SETTINGS.factor}×.`}
            sx={{ width: 200 }}
            onChange={(factor) => update({ factor })}
          />
        ) : null}
        {value.mode === "size" ? (
          <>
            <NumberField
              label="Width"
              value={value.width}
              min={SETTING_RANGES.width.min}
              max={widthMax}
              step={16}
              integer
              error={value.width > widthMax}
              helperText={`Output width in pixels (${SETTING_RANGES.width.min}–${widthMax}). Default ${DEFAULT_SCALE_SETTINGS.width}.`}
              sx={{ width: 220 }}
              onChange={(width) => update({ width })}
            />
            <NumberField
              label="Height"
              value={value.height}
              min={SETTING_RANGES.height.min}
              max={heightMax}
              step={16}
              integer
              error={value.height > heightMax}
              helperText={`Output height in pixels (${SETTING_RANGES.height.min}–${heightMax}). Default ${DEFAULT_SCALE_SETTINGS.height}.`}
              sx={{ width: 220 }}
              onChange={(height) => update({ height })}
            />
          </>
        ) : null}
      </Stack>
      {limits.note && value.mode !== "none" ? <FormHelperText error={outside}>{limits.note}</FormHelperText> : null}
    </Stack>
  );
}
