import { useEffect, useId, useState } from "react";
import { FormControl, FormHelperText, InputLabel, MenuItem, Select } from "@mui/material";
import type { RuntimeManifest } from "../../../src/ngx/runtime-catalog";
import { api } from "../api";
import { errorMessage } from "../errors";

interface VersionSelectProps {
  /** NGX feature id: 1 = Super Resolution, 18 = Neural Rendering. */
  featureId: number;
  /** Selected DLL folder, or "" for the bundled default. */
  value: string;
  disabled?: boolean;
  onChange: (dir: string) => void;
}

/** Lets the user pick a specific installed DLSS DLL version (or the bundled default) for a feature. */
export function VersionSelect({ featureId, value, disabled, onChange }: VersionSelectProps) {
  // Per instance, not per feature: the image and video panels both render the
  // version picker for the same feature, so a feature-keyed id appears twice.
  const labelId = useId();
  const [catalog, setCatalog] = useState<RuntimeManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .catalog()
      .then((c) => active && setCatalog(c))
      .catch((e) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, []);

  const versions = catalog?.features.find((f) => f.id === featureId)?.versions ?? [];

  return (
    <FormControl sx={{ minWidth: 220 }} disabled={disabled}>
      <InputLabel id={labelId}>DLSS version</InputLabel>
      <Select<string>
        labelId={labelId}
        label="DLSS version"
        value={value}
        onChange={(event) => onChange(String(event.target.value))}
      >
        <MenuItem value="">Bundled (default)</MenuItem>
        {versions.map((v) => (
          <MenuItem key={v.dir} value={v.dir}>
            {v.version} ({v.source})
          </MenuItem>
        ))}
      </Select>
      <FormHelperText>
        {error
          ? `Could not load versions: ${error}`
          : versions.length > 0
            ? "Use a specific installed DLSS DLL, or the bundled one."
            : "Only the bundled DLL is installed."}
      </FormHelperText>
    </FormControl>
  );
}
