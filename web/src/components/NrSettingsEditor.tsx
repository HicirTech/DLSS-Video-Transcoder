import { useId } from "react";
import { Box, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch, Typography } from "@mui/material";
import { NR_IGNORED_NOTE, NR_INTENSITY_EFFECTIVE_MAX, type NrSettings, nrSettingIgnored, SETTING_RANGES } from "../../../src/server/api-types";
import { SliderRow } from "./SliderRow";

interface NrSettingsEditorProps {
  value: NrSettings;
  onChange: (next: NrSettings) => void;
}

const NEUTRAL_MARKS = [{ value: 0 }, { value: 1, label: "default" }, { value: 2 }];
const INTENSITY_MARKS = [{ value: 0 }, { value: NR_INTENSITY_EFFECTIVE_MAX, label: "default" }];
const SKIN_MARKS = [{ value: -1, label: "default" }, { value: 0 }, { value: 1, label: "neutral" }, { value: 2 }];

function formatSkin(value: number): string {
  return value < 0 ? "runtime default" : value.toFixed(2);
}

/**
 * Look controls for DLSS neural rendering (feature 18): style, model preset and the strength
 * sliders. `warmupFrames` is edited in the Settings tab. A control the installed runtime
 * ignores (nrSettingIgnored, measured) is shown disabled rather than hidden, so re-enabling it
 * after a runtime update is a change to that list alone; UI correction has no counterpart in
 * the reference tool and is not offered here at all.
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
                <MenuItem value={0}>Default</MenuItem>
                <MenuItem value={1}>Natural</MenuItem>
                <MenuItem value={2}>Cinematic</MenuItem>
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
                <MenuItem value={0}>Default</MenuItem>
                <MenuItem value={1}>Preset #1</MenuItem>
                <MenuItem value={2}>Preset #2</MenuItem>
                <MenuItem value={3}>Preset #3</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
            Style sets the overall look (strong effect). Model preset and skin structure are disabled because{" "}
            {NR_IGNORED_NOTE}.
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
          min={0}
          max={NR_INTENSITY_EFFECTIVE_MAX}
          marks={INTENSITY_MARKS}
          hint={`Overall neural-rendering strength. 0 = original, ${NR_INTENSITY_EFFECTIVE_MAX} = default and also the most the installed runtime responds to; the API still accepts up to ${SETTING_RANGES.intensity.max}.`}
          onChange={(intensity) => update({ intensity })}
        />
        <SliderRow
          label="Local tone"
          value={value.localTone}
          min={0}
          max={2}
          marks={NEUTRAL_MARKS}
          hint="Contrast within small regions. 1 = neutral."
          onChange={(localTone) => update({ localTone })}
        />
        <SliderRow
          label="Local structure"
          value={value.localStructure}
          min={0}
          max={2}
          marks={NEUTRAL_MARKS}
          hint="Fine detail / micro-structure. 1 = neutral."
          onChange={(localStructure) => update({ localStructure })}
        />
        <SliderRow
          label="Skin structure"
          value={value.skinStructure}
          min={-1}
          max={2}
          marks={SKIN_MARKS}
          format={formatSkin}
          disabled={nrSettingIgnored("skinStructure")}
          hint="Detail strength on skin regions only. Leftmost = runtime default; 1 = neutral. Disabled: see the note above."
          onChange={(skinStructure) => update({ skinStructure: skinStructure < 0 ? -1 : skinStructure })}
        />
      </Stack>
    </Box>
  );
}
