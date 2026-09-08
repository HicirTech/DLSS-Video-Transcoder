import { useState } from "react";
import { TextField, type SxProps, type Theme } from "@mui/material";

interface NumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  disabled?: boolean;
  helperText?: string;
  sx?: SxProps<Theme>;
  onChange: (value: number) => void;
}

/** Numeric TextField that commits a clamped value on blur or Enter, so the field can be cleared while typing. */
export function NumberField({ label, value, min, max, step, integer, disabled, helperText, sx, onChange }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft === null) return;
    let next = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(next)) {
      setDraft(null);
      return;
    }
    if (integer) next = Math.round(next);
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(null);
    if (next !== value) onChange(next);
  };

  return (
    <TextField
      label={label}
      type="number"
      value={draft ?? String(value)}
      disabled={disabled}
      helperText={helperText}
      sx={sx}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setDraft(String(value))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      slotProps={{ htmlInput: { min, max, step, inputMode: "decimal" } }}
    />
  );
}
