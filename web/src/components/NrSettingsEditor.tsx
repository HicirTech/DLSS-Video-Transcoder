import { Box, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch, Typography } from "@mui/material";
import type { NrSettings } from "../../../src/server/api-types";
import { SliderRow } from "./SliderRow";

interface NrSettingsEditorProps {
  value: NrSettings;
  onChange: (next: NrSettings) => void;
}

const NEUTRAL_MARKS = [{ value: 0 }, { value: 1, label: "neutral" }, { value: 2 }];
const SKIN_MARKS = [{ value: -1, label: "default" }, { value: 0 }, { value: 1, label: "neutral" }, { value: 2 }];

function formatSkin(value: number): string {
  return value < 0 ? "runtime default" : value.toFixed(2);
}

/** Editor for the DLSS 5 neural rendering look controls. `nrPath` and `warmupFrames` live in the Settings tab. */
export function NrSettingsEditor({ value, onChange }: NrSettingsEditorProps) {
  const update = (patch: Partial<NrSettings>): void => onChange({ ...value, ...patch });
  const globalToneEnabled = value.globalTone !== null;

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) minmax(0, 1fr)" }, gap: 3 }}>
      <Stack spacing={2}>
        <Box>
          <Stack direction="row" spacing={2}>
            <FormControl fullWidth>
              <InputLabel id="nr-preset-label">Model preset</InputLabel>
              <Select<NrSettings["preset"]>
                labelId="nr-preset-label"
                label="Model preset"
                value={value.preset}
                onChange={(event) => update({ preset: event.target.value })}
              >
                <MenuItem value={0}>Default (runtime chooses)</MenuItem>
                <MenuItem value={10}>Model J</MenuItem>
                <MenuItem value={11}>Model K</MenuItem>
                <MenuItem value={12}>Model L</MenuItem>
                <MenuItem value={13}>Model M</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel id="nr-style-label">Style</InputLabel>
              <Select<NrSettings["style"]>
                labelId="nr-style-label"
                label="Style"
                value={value.style}
                onChange={(event) => update({ style: event.target.value })}
              >
                <MenuItem value={0}>Default</MenuItem>
                <MenuItem value={1}>Natural</MenuItem>
                <MenuItem value={2}>Cinematic</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
            Model preset picks the neural model revision: Default lets the runtime choose; J–M are
            transformer models (later letter = newer). Style sets the overall look.
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
        <Box>
          <FormControlLabel
            control={
              <Switch checked={value.uiCorrection} onChange={(_event, checked) => update({ uiCorrection: checked })} />
            }
            label="UI correction"
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", ml: 4.5, mt: -0.5 }}>
            Protect overlays, text and sharp UI edges from re-rendering.
          </Typography>
        </Box>
        <Box>
          <FormControlLabel
            control={
              <Switch
                checked={globalToneEnabled}
                onChange={(_event, checked) => update({ globalTone: checked ? 1 : null })}
              />
            }
            label="Send global tone"
          />
          <SliderRow
            label="Global tone"
            value={value.globalTone ?? 1}
            min={0}
            max={2}
            marks={NEUTRAL_MARKS}
            disabled={!globalToneEnabled}
            hint={globalToneEnabled ? undefined : "Off: the parameter is not sent and the runtime keeps its own tone mapping."}
            onChange={(globalTone) => update({ globalTone })}
          />
        </Box>
      </Stack>

      <Stack spacing={1.5}>
        <SliderRow
          label="Intensity"
          value={value.intensity}
          min={0}
          max={2}
          marks={NEUTRAL_MARKS}
          hint="Overall enhancement strength. 1 = neutral, 0 = off, 2 = strongest."
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
          hint="Detail strength on skin. Leftmost = runtime default; 1 = neutral."
          onChange={(skinStructure) => update({ skinStructure: skinStructure < 0 ? -1 : skinStructure })}
        />
      </Stack>
    </Box>
  );
}
