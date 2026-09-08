import { FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch } from "@mui/material";
import type { EncodeSettings } from "../../../src/server/api-types";
import { NumberField } from "./NumberField";

interface EncodeSettingsEditorProps {
  value: EncodeSettings;
  onChange: (next: EncodeSettings) => void;
}

const CODECS: Array<{ value: EncodeSettings["codec"]; label: string }> = [
  { value: "h264", label: "H.264 (software)" },
  { value: "hevc", label: "HEVC / H.265 (software)" },
  { value: "av1", label: "AV1 (software)" },
  { value: "h264_nvenc", label: "H.264 (NVIDIA GPU)" },
  { value: "hevc_nvenc", label: "HEVC / H.265 (NVIDIA GPU)" },
  { value: "av1_nvenc", label: "AV1 (NVIDIA GPU)" },
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
        helperText="0–51, lower = better quality and larger file. Default 18."
        sx={{ width: 240 }}
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
        label="Copy source audio track"
      />
    </Stack>
  );
}
