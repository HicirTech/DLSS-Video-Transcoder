import { type ChangeEvent, useId, useState } from "react";
import { Button, FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack, TextField } from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { ENGINE_KINDS, type EngineKind, MOTION_KINDS, type MotionKind } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";

// Record<...>: an engine or motion the API accepts without menu words is a build error, not a blank item.
const ENGINE_MENU_LABELS: Record<EngineKind, string> = {
  sr: "DLSS Super Resolution (upscale)",
  nr: "DLSS Neural Rendering (enhance)",
  bypass: "Bypass (passthrough copy, no DLSS)",
};
const MOTION_MENU_LABELS: Record<MotionKind, string> = {
  none: "None — process each frame independently",
  flow: "Optical flow (estimate motion between frames)",
};

interface PathFieldsProps {
  kind: "image" | "video";
  input: string;
  output: string;
  disabled?: boolean;
  onInputChange: (value: string) => void;
  onOutputChange: (value: string) => void;
}

/** Absolute input / optional output path fields shared by the Image and Video tabs. */
export function PathFields({ kind, input, output, disabled, onInputChange, onOutputChange }: PathFieldsProps) {
  const example = kind === "image" ? "C:\\Pictures\\photo.png" : "D:\\Footage\\clip.mp4";
  // Image jobs read PNG only (processImage); the server queues any other format and the job then fails.
  const accept = kind === "image" ? ".png,image/png" : "video/*";
  const inputHelp =
    kind === "image"
      ? "Absolute path of a PNG on the machine that runs the server — or upload one. Image jobs take PNG only; any other format is queued and then fails."
      : "Absolute path on the machine that runs the server — or upload a file.";
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onPick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = ""; // an <input type=file> only fires change when the value differs
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const result = await api.uploadFile(file);
      onInputChange(result.path);
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <TextField
          label="Input path"
          placeholder={example}
          value={input}
          disabled={disabled}
          fullWidth
          required
          error={Boolean(uploadError)}
          helperText={uploadError ?? inputHelp}
          onChange={(event) => onInputChange(event.target.value)}
          slotProps={{ htmlInput: { spellCheck: false } }}
        />
        <Button
          component="label"
          variant="outlined"
          startIcon={<UploadFileIcon />}
          disabled={disabled || uploading}
          sx={{ mt: 1, whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {uploading ? "Uploading…" : "Upload"}
          <input hidden type="file" accept={accept} onChange={(event) => void onPick(event)} />
        </Button>
      </Stack>
      <TextField
        label="Output path"
        placeholder="Leave empty to write next to the input with a suffix"
        value={output}
        disabled={disabled}
        fullWidth
        onChange={(event) => onOutputChange(event.target.value)}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
    </Stack>
  );
}

interface EngineSelectProps {
  value: EngineKind;
  disabled?: boolean;
  onChange: (value: EngineKind) => void;
}

export function EngineSelect({ value, disabled, onChange }: EngineSelectProps) {
  const engineLabelId = useId();
  return (
    <FormControl sx={{ minWidth: 260 }} disabled={disabled}>
      <InputLabel id={engineLabelId}>Engine</InputLabel>
      <Select<EngineKind>
        labelId={engineLabelId}
        label="Engine"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {ENGINE_KINDS.map((engine) => (
          <MenuItem key={engine} value={engine}>
            {ENGINE_MENU_LABELS[engine]}
          </MenuItem>
        ))}
      </Select>
      <FormHelperText>
        Super Resolution upscales to the output size below. Neural rendering enhances each frame at its current
        size. Bypass copies frames unchanged, for comparison.
      </FormHelperText>
    </FormControl>
  );
}

interface MotionSelectProps {
  value: MotionKind;
  disabled?: boolean;
  onChange: (value: MotionKind) => void;
}

export function MotionSelect({ value, disabled, onChange }: MotionSelectProps) {
  const motionLabelId = useId();
  return (
    <FormControl sx={{ minWidth: 220 }} disabled={disabled}>
      <InputLabel id={motionLabelId}>Motion</InputLabel>
      <Select<MotionKind>
        labelId={motionLabelId}
        label="Motion"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {MOTION_KINDS.map((motion) => (
          <MenuItem key={motion} value={motion}>
            {MOTION_MENU_LABELS[motion]}
          </MenuItem>
        ))}
      </Select>
      <FormHelperText>
        Optical flow estimates motion between frames for steadier temporal results — using the GPU hardware
        flow engine (NVOFA) when available, otherwise a slower CPU estimator. Super Resolution only: Neural
        Rendering and bypass take no motion vectors.
      </FormHelperText>
    </FormControl>
  );
}
