import { useId } from "react";
import { FormControl, FormControlLabel, FormHelperText, InputLabel, MenuItem, Select, Stack, Switch } from "@mui/material";
import { DEFAULT_ENCODE_SETTINGS, ENCODE_CODECS, ENCODE_CONTAINERS, SETTING_RANGES, type EncodeSettings } from "../../../src/server/api-types";
import { NumberField } from "./NumberField";

interface EncodeSettingsEditorProps {
  value: EncodeSettings;
  /** A container the job is going to write whatever is stored, shown locked with the reason. */
  fixedContainer?: { container: EncodeSettings["container"]; reason: string };
  onChange: (next: EncodeSettings) => void;
}

// Record<...>: a codec or container the API accepts without menu words is a build error, not a blank item.
const CODEC_LABELS: Record<EncodeSettings["codec"], string> = {
  h264: "H.264 (software)",
  hevc: "HEVC / H.265 (software)",
  av1: "AV1 (software)",
  h264_nvenc: "H.264 (NVIDIA GPU)",
  hevc_nvenc: "HEVC / H.265 (NVIDIA GPU)",
  av1_nvenc: "AV1 (NVIDIA GPU)",
};
const CONTAINER_LABELS: Record<EncodeSettings["container"], string> = { mp4: "MP4", mkv: "MKV", mov: "MOV" };

export function EncodeSettingsEditor({ value, fixedContainer, onChange }: EncodeSettingsEditorProps) {
  const codecLabelId = useId();
  const containerLabelId = useId();
  const update = (patch: Partial<EncodeSettings>): void => onChange({ ...value, ...patch });

  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <FormControl sx={{ minWidth: 200 }}>
        <InputLabel id={codecLabelId}>Codec</InputLabel>
        <Select<EncodeSettings["codec"]>
          labelId={codecLabelId}
          label="Codec"
          value={value.codec}
          onChange={(event) => update({ codec: event.target.value })}
        >
          {ENCODE_CODECS.map((codec) => (
            <MenuItem key={codec} value={codec}>
              {CODEC_LABELS[codec]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <NumberField
        label="Quality (CRF / CQ)"
        value={value.quality}
        {...SETTING_RANGES.quality}
        step={1}
        helperText={`${SETTING_RANGES.quality.min}–${SETTING_RANGES.quality.max}, lower = better quality and larger file. Default ${DEFAULT_ENCODE_SETTINGS.quality}.`}
        sx={{ width: 240 }}
        onChange={(quality) => update({ quality })}
      />
      <FormControl sx={{ minWidth: 120 }} disabled={fixedContainer !== undefined}>
        <InputLabel id={containerLabelId}>Container</InputLabel>
        <Select<EncodeSettings["container"]>
          labelId={containerLabelId}
          label="Container"
          value={fixedContainer?.container ?? value.container}
          onChange={(event) => update({ container: event.target.value })}
        >
          {ENCODE_CONTAINERS.map((container) => (
            <MenuItem key={container} value={container}>
              {CONTAINER_LABELS[container]}
            </MenuItem>
          ))}
        </Select>
        {fixedContainer ? <FormHelperText>{fixedContainer.reason}</FormHelperText> : null}
      </FormControl>
      <FormControlLabel
        sx={{ ml: 0, mt: 0.5 }}
        control={<Switch checked={value.copyAudio} onChange={(_event, checked) => update({ copyAudio: checked })} />}
        label="Copy source audio track"
      />
    </Stack>
  );
}
