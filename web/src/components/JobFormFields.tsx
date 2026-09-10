import { type ChangeEvent, useId, useState } from "react";
import { Button, FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack, TextField } from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import type { EngineKind, MotionKind } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";

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
  const accept = kind === "image" ? "image/*" : "video/*";
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
          helperText={uploadError ?? "Absolute path on the machine that runs the server — or upload a file."}
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
  // useId, not a constant: every tab stays mounted, so two panels can render
  // this component at once and a fixed id would appear twice in one document.
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
        <MenuItem value="sr">DLSS Super Resolution (upscale)</MenuItem>
        <MenuItem value="nr">DLSS Neural Rendering (enhance)</MenuItem>
        <MenuItem value="bypass">Bypass (passthrough copy, no DLSS)</MenuItem>
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
  // useId, not a constant: every tab stays mounted, so two panels can render
  // this component at once and a fixed id would appear twice in one document.
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
        <MenuItem value="none">None — process each frame independently</MenuItem>
        <MenuItem value="flow">Optical flow (estimate motion between frames)</MenuItem>
      </Select>
      <FormHelperText>
        Optical flow estimates motion between frames for steadier temporal results — using the GPU hardware
        flow engine (NVOFA) when available, otherwise a slower CPU estimator.
      </FormHelperText>
    </FormControl>
  );
}
