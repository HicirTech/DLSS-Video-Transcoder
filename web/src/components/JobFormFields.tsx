import { FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack, TextField } from "@mui/material";
import type { EngineKind, MotionKind } from "../../../src/server/api-types";

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
  return (
    <Stack spacing={1.5}>
      <TextField
        label="Input path"
        placeholder={example}
        value={input}
        disabled={disabled}
        fullWidth
        required
        helperText="Absolute path on the machine that runs the server."
        onChange={(event) => onInputChange(event.target.value)}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
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
  return (
    <FormControl sx={{ minWidth: 260 }} disabled={disabled}>
      <InputLabel id="engine-label">Engine</InputLabel>
      <Select<EngineKind>
        labelId="engine-label"
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
  return (
    <FormControl sx={{ minWidth: 220 }} disabled={disabled}>
      <InputLabel id="motion-label">Motion</InputLabel>
      <Select<MotionKind>
        labelId="motion-label"
        label="Motion"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <MenuItem value="none">None — process each frame independently</MenuItem>
        <MenuItem value="flow">Optical flow (estimate motion between frames)</MenuItem>
      </Select>
      <FormHelperText>
        Optical flow estimates motion between frames for steadier temporal results, but the current estimator is
        slow.
      </FormHelperText>
    </FormControl>
  );
}
