import { type ChangeEvent, useId, useState } from "react";
import { Button, FormControl, FormHelperText, InputLabel, MenuItem, Select, Stack, TextField } from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { MOTION_KINDS, type MotionKind } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";

// Record<...>: a motion mode the API accepts without menu words is a build error, not a blank item.
const MOTION_MENU_LABELS: Record<MotionKind, string> = {
  none: "None — process each frame independently",
  flow: "Optical flow (estimate motion between frames)",
};

interface InputPathFieldProps {
  kind: "image" | "video";
  value: string;
  onChange: (value: string) => void;
}

/** The absolute input path, typed or filled in by an upload; shared by the Image and Video tabs. */
export function InputPathField({ kind, value, onChange }: InputPathFieldProps) {
  const example = kind === "image" ? "C:\\Pictures\\photo.png" : "D:\\Footage\\clip.mp4";
  // Image jobs read PNG only (processImage); the server queues any other format and the job then fails.
  const accept = kind === "image" ? ".png,image/png" : "video/*";
  const help =
    kind === "image"
      ? "Absolute path of a PNG on the machine that runs the server — or upload one. Image jobs take PNG only."
      : "Absolute path on the machine that runs the server — or upload a file. Any format ffmpeg can decode.";
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
      onChange(result.path);
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
      <TextField
        label="Input path"
        placeholder={example}
        value={value}
        fullWidth
        required
        error={Boolean(uploadError)}
        helperText={uploadError ?? help}
        onChange={(event) => {
          // A typed path replaces the one the failed upload was to fill in, so its error no longer applies.
          setUploadError(null);
          onChange(event.target.value);
        }}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
      <Button
        component="label"
        variant="outlined"
        startIcon={<UploadFileIcon />}
        disabled={uploading}
        sx={{ mt: 1, whiteSpace: "nowrap", flexShrink: 0 }}
      >
        {uploading ? "Uploading…" : "Upload"}
        <input hidden type="file" accept={accept} onChange={(event) => void onPick(event)} />
      </Button>
    </Stack>
  );
}

interface OutputPathFieldProps {
  value: string;
  /** The file name the job gives its output when this is left empty (planJob), or null before there is an input. */
  defaultName: string | null;
  onChange: (value: string) => void;
}

/** The optional output path; empty writes next to the input under the name the steps give it. */
export function OutputPathField({ value, defaultName, onChange }: OutputPathFieldProps) {
  return (
    <TextField
      label="Output path"
      placeholder={defaultName ? `Leave empty to write ${defaultName} next to the input` : "Leave empty to write next to the input, named after the steps"}
      value={value}
      fullWidth
      onChange={(event) => onChange(event.target.value)}
      slotProps={{ htmlInput: { spellCheck: false }, inputLabel: { shrink: true } }}
    />
  );
}

interface MotionSelectProps {
  value: MotionKind;
  onChange: (value: MotionKind) => void;
}

export function MotionSelect({ value, onChange }: MotionSelectProps) {
  const motionLabelId = useId();
  return (
    <FormControl sx={{ minWidth: 260, maxWidth: 420 }}>
      <InputLabel id={motionLabelId}>Motion</InputLabel>
      <Select<MotionKind> labelId={motionLabelId} label="Motion" value={value} onChange={(event) => onChange(event.target.value)}>
        {MOTION_KINDS.map((motion) => (
          <MenuItem key={motion} value={motion}>
            {MOTION_MENU_LABELS[motion]}
          </MenuItem>
        ))}
      </Select>
      <FormHelperText>
        Optical flow hands Super Resolution the motion between frames, for steadier detail over time: on the GPU's
        hardware flow engine (NVOFA) when it starts, otherwise a slower CPU estimator.
      </FormHelperText>
    </FormControl>
  );
}
