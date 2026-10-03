import { useId } from "react";
import { Box, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch, Typography } from "@mui/material";
import {
  DEFAULT_NR_SETTINGS,
  NR_IGNORED_NOTE,
  NR_INTENSITY_EFFECTIVE_MAX,
  NR_PRESETS,
  NR_STYLES,
  NR_STYLE_LABELS,
  type NrSettings,
  nrSettingIgnored,
  SETTING_RANGES,
} from "../../../src/server/api-types";
import { SliderRow } from "./SliderRow";

interface NrSettingsEditorProps {
  value: NrSettings;
  onChange: (next: NrSettings) => void;
}

/** Menu words for each model preset; the Record makes a preset without words a build error. */
const PRESET_LABELS: Record<NrSettings["preset"], string> = { 0: "Default", 1: "Preset #1", 2: "Preset #2", 3: "Preset #3" };

/** Marks at both ends of a slider's range and at its default value. */
function marksAcross(range: { min: number; max: number }, defaultValue: number): Array<{ value: number; label?: string }> {
  return [{ value: range.min }, { value: defaultValue, label: "default" }, { value: range.max }];
}

const TONE_MARKS = marksAcross(SETTING_RANGES.localTone, DEFAULT_NR_SETTINGS.localTone);
const STRUCTURE_MARKS = marksAcross(SETTING_RANGES.localStructure, DEFAULT_NR_SETTINGS.localStructure);
const INTENSITY_MARKS = [{ value: SETTING_RANGES.intensity.min }, { value: DEFAULT_NR_SETTINGS.intensity, label: "default" }];

/** The controls this editor shows that the installed runtime ignores, named as the UI labels them; empty once the runtime honours them. */
const DISABLED_HERE = (
  [
    ["preset", "Model preset"],
    ["skinStructure", "Skin structure"],
  ] as const
).filter(([key]) => nrSettingIgnored(key)).map(([, label]) => label);
const SKIN_MARKS = [{ value: SETTING_RANGES.skinStructure.min, label: "default" }, { value: 0 }, { value: 1, label: "neutral" }, { value: SETTING_RANGES.skinStructure.max }];

function formatSkin(value: number): string {
  return value < 0 ? "runtime default" : value.toFixed(2);
}

/**
 * Look controls for DLSS neural rendering (feature 18): style, model preset and the strength
 * sliders. `warmupFrames` is edited in the Settings tab. A control the installed runtime
 * ignores (nrSettingIgnored, measured) is shown disabled rather than hidden, and the caption
 * that says so is built from the same list, so re-enabling it after a runtime update is a
 * change to NR_SETTINGS_IGNORED_BY_RUNTIME alone; UI correction has no counterpart in the
 * reference tool and is not offered here at all.
 */
export function NrSettingsEditor({ value, onChange }: NrSettingsEditorProps) {
  // useId, not a constant: every tab stays mounted, so two panels can render
  // this component at once and a fixed id would appear twice in one document.
  const styleLabelId = useId();
  const presetLabelId = useId();
  const update = (patch: Partial<NrSettings>): void => onChange({ ...value, ...patch });

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) minmax(0, 1fr)" }, gap: 3 }}>
      <Stack spacing={2}>
        <Box>
          <Stack direction="row" spacing={2}>
            <FormControl fullWidth>
              <InputLabel id={styleLabelId}>Style</InputLabel>
              <Select<NrSettings["style"]>
                labelId={styleLabelId}
                label="Style"
                value={value.style}
                onChange={(event) => update({ style: event.target.value })}
              >
                {NR_STYLES.map((style) => (
                  <MenuItem key={style} value={style}>
                    {NR_STYLE_LABELS[style]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth disabled={nrSettingIgnored("preset")}>
              <InputLabel id={presetLabelId}>Model preset</InputLabel>
              <Select<NrSettings["preset"]>
                labelId={presetLabelId}
                label="Model preset"
                value={value.preset}
                onChange={(event) => update({ preset: event.target.value })}
              >
                {NR_PRESETS.map((preset) => (
                  <MenuItem key={preset} value={preset}>
                    {PRESET_LABELS[preset]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
            Style sets the overall look (strong effect).
            {DISABLED_HERE.length ? ` ${DISABLED_HERE.join(" and ")} ${DISABLED_HERE.length === 1 ? "is" : "are"} disabled: ${NR_IGNORED_NOTE}.` : null}
          </Typography>
        </Box>

        <Box>
          <FormControlLabel
            control={<Switch checked={value.autoMask} onChange={(_event, checked) => update({ autoMask: checked })} />}
            label="Auto mask"
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", ml: 4.5, mt: -0.5 }}>
            Let the runtime derive the region mask instead of processing the whole frame.
          </Typography>
        </Box>
      </Stack>

      <Stack spacing={1.5}>
        <SliderRow
          label="Intensity"
          value={value.intensity}
          min={SETTING_RANGES.intensity.min}
          max={NR_INTENSITY_EFFECTIVE_MAX}
          marks={INTENSITY_MARKS}
          hint={`Overall neural-rendering strength. 0 = original, ${DEFAULT_NR_SETTINGS.intensity} = default; the slider ends at ${NR_INTENSITY_EFFECTIVE_MAX}, the most the installed runtime responds to, while the API still accepts up to ${SETTING_RANGES.intensity.max}.`}
          onChange={(intensity) => update({ intensity })}
        />
        <SliderRow
          label="Local tone"
          value={value.localTone}
          min={SETTING_RANGES.localTone.min}
          max={SETTING_RANGES.localTone.max}
          marks={TONE_MARKS}
          hint="Contrast within small regions. 1 = neutral."
          onChange={(localTone) => update({ localTone })}
        />
        <SliderRow
          label="Local structure"
          value={value.localStructure}
          min={SETTING_RANGES.localStructure.min}
          max={SETTING_RANGES.localStructure.max}
          marks={STRUCTURE_MARKS}
          hint="Fine detail / micro-structure. 1 = neutral."
          onChange={(localStructure) => update({ localStructure })}
        />
        <SliderRow
          label="Skin structure"
          value={value.skinStructure}
          min={SETTING_RANGES.skinStructure.min}
          max={SETTING_RANGES.skinStructure.max}
          marks={SKIN_MARKS}
          format={formatSkin}
          disabled={nrSettingIgnored("skinStructure")}
          hint={`Detail strength on skin regions only. Leftmost = runtime default; 1 = neutral.${nrSettingIgnored("skinStructure") ? " Disabled: see the note above." : ""}`}
          onChange={(skinStructure) => update({ skinStructure: skinStructure < 0 ? SETTING_RANGES.skinStructure.min : skinStructure })}
        />
      </Stack>
    </Box>
  );
}
