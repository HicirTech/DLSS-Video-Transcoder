import { FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch } from "@mui/material";
import type { EncodeSettings } from "../../../src/server/api-types";
import { NumberField } from "./NumberField";

interface EncodeSettingsEditorProps {
  value: EncodeSettings;
  onChange: (next: EncodeSettings) => void;
}

const CODECS: Array<{ value: EncodeSettings["codec"]; label: string }> = [
  { value: "h264", label: "H.264 (libx264)" },
  { value: "hevc", label: "HEVC (libx265)" },
  { value: "av1", label: "AV1 (software)" },
  { value: "h264_nvenc", label: "H.264 NVENC" },
  { value: "hevc_nvenc", label: "HEVC NVENC" },
  { value: "av1_nvenc", label: "AV1 NVENC" },
];

export function EncodeSettingsEditor({ value, onChange }: EncodeSettingsEditorProps) {
  const update = (patch: Partial<EncodeSettings>): void => onChange({ ...value, ...patch });

  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <FormControl sx={{ minWidth: 200 }}>
        <InputLabel id="encode-codec-label">Codec</InputLabel>
        <Select<EncodeSettings["codec"]>
          labelId="encode-codec-label"
          label="Codec"
          value={value.codec}
          onChange={(event) => update({ codec: event.target.value })}
        >
          {CODECS.map((codec) => (
            <MenuItem key={codec.value} value={codec.value}>
              {codec.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <NumberField
        label="Quality (CRF / CQ)"
        value={value.quality}
        min={0}
        max={51}
        step={1}
        integer
        helperText="Lower is better"
        sx={{ width: 160 }}
        onChange={(quality) => update({ quality })}
      />
      <FormControl sx={{ minWidth: 120 }}>
        <InputLabel id="encode-container-label">Container</InputLabel>
        <Select<EncodeSettings["container"]>
          labelId="encode-container-label"
          label="Container"
          value={value.container}
          onChange={(event) => update({ container: event.target.value })}
        >
          <MenuItem value="mp4">MP4</MenuItem>
          <MenuItem value="mkv">MKV</MenuItem>
          <MenuItem value="mov">MOV</MenuItem>
        </Select>
      </FormControl>
      <FormControlLabel
        sx={{ ml: 0, mt: 0.5 }}
        control={<Switch checked={value.copyAudio} onChange={(_event, checked) => update({ copyAudio: checked })} />}
        label="Copy audio"
      />
    </Stack>
  );
}
