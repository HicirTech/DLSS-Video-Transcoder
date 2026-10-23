import { useId } from "react";
import { FormControl, FormControlLabel, FormHelperText, InputLabel, MenuItem, Select, Stack, Switch } from "@mui/material";
import { AAC_KBPS, AUDIO_IN_CONTAINER, DEFAULT_ENCODE_SETTINGS, ENCODE_CODECS, ENCODE_CONTAINERS, SETTING_RANGES, type EncodeSettings } from "../../../src/server/api-types";
import { nvencCodecsWithin, nvencLimitExceeded } from "../../../src/server/output-size";
import { type FrameSize, formatSize } from "../job-plan";
import { NumberField } from "./NumberField";

interface EncodeSettingsEditorProps {
  value: EncodeSettings;
  /** A container the job is going to write whatever is stored, shown locked with the reason. */
  fixedContainer?: { container: EncodeSettings["container"]; reason: string };
  /** The size the job encodes, once the source's is known: an NVENC codec that does not take it is flagged. */
  outputSize?: { width: number; height: number } | null;
  onChange: (next: EncodeSettings) => void;
}

// Record<...>: a codec or container the API accepts without menu words is a build error, not a blank item.
export const CODEC_LABELS: Record<EncodeSettings["codec"], string> = {
  h264: "H.264 (software)",
  hevc: "HEVC / H.265 (software)",
  av1: "AV1 (software)",
  h264_nvenc: "H.264 (NVIDIA GPU)",
  hevc_nvenc: "HEVC / H.265 (NVIDIA GPU)",
  av1_nvenc: "AV1 (NVIDIA GPU)",
};
export const CONTAINER_LABELS: Record<EncodeSettings["container"], string> = { mp4: "MP4", mkv: "MKV", mov: "MOV" };

/**
 * What the codec field says when the job's output is larger than the chosen NVENC encoder takes (NVENC_MAX_SIDE),
 * else null: the job then encodes the same format on the CPU (resolveEncodeCodec).
 */
function nvencLimitNote(codec: EncodeSettings["codec"], size: { width: number; height: number } | null | undefined): string | null {
  const limit = size ? nvencLimitExceeded(codec, size) : null;
  if (!size || limit === null) return null;
  const onGpu = nvencCodecsWithin(size).map((other) => CODEC_LABELS[other]);
  const instead = onGpu.length ? ` ${onGpu.join(" or ")} would keep it on the GPU.` : "";
  return `${CODEC_LABELS[codec]} encodes at most ${limit} pixels per side, so at ${size.width}×${size.height} this job encodes the same format on the CPU instead, which is slower.${instead}`;
}

/** The audio switch's words for what the container in effect does with the track (AUDIO_IN_CONTAINER). */
function audioSwitchLabel(container: EncodeSettings["container"]): string {
  return AUDIO_IN_CONTAINER[container] === "copy" ? "Copy the source audio track" : `Keep the source audio, re-encoded to AAC ${AAC_KBPS} kb/s`;
}

export function EncodeSettingsEditor({ value, fixedContainer, outputSize, onChange }: EncodeSettingsEditorProps) {
  const codecLabelId = useId();
  const codecHelpId = useId();
  const containerLabelId = useId();
  const containerHelpId = useId();
  const update = (patch: Partial<EncodeSettings>): void => onChange({ ...value, ...patch });
  const container = fixedContainer?.container ?? value.container;
  const limitNote = nvencLimitNote(value.codec, outputSize);

  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <FormControl sx={{ minWidth: 200, maxWidth: 420 }}>
        <InputLabel id={codecLabelId}>Codec</InputLabel>
        <Select<EncodeSettings["codec"]>
          labelId={codecLabelId}
          label="Codec"
          value={value.codec}
          aria-describedby={limitNote ? codecHelpId : undefined}
          onChange={(event) => update({ codec: event.target.value })}
        >
          {ENCODE_CODECS.map((codec) => (
            <MenuItem key={codec} value={codec}>
              {CODEC_LABELS[codec]}
            </MenuItem>
          ))}
        </Select>
        {limitNote ? (
          <FormHelperText id={codecHelpId} sx={{ color: "warning.main" }}>
            {limitNote}
          </FormHelperText>
        ) : null}
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
          value={container}
          aria-describedby={fixedContainer ? containerHelpId : undefined}
          onChange={(event) => update({ container: event.target.value })}
        >
          {ENCODE_CONTAINERS.map((container) => (
            <MenuItem key={container} value={container}>
              {CONTAINER_LABELS[container]}
            </MenuItem>
          ))}
        </Select>
        {fixedContainer ? <FormHelperText id={containerHelpId}>{fixedContainer.reason}</FormHelperText> : null}
      </FormControl>
      <FormControlLabel
        sx={{ ml: 0, mt: 0.5 }}
        control={<Switch checked={value.copyAudio} onChange={(_event, checked) => update({ copyAudio: checked })} />}
        label={audioSwitchLabel(container)}
      />
    </Stack>
  );
}
