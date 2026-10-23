import { useEffect, useId, useState } from "react";
import { FormControl, FormHelperText, InputLabel, MenuItem, Select } from "@mui/material";
import type { RuntimeManifest } from "../../../src/ngx/runtime-catalog";
import type { StepKind } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";

interface VersionSelectProps {
  /** The step whose DLL's installed versions are offered: a step's key is its feature's key in the catalog. */
  feature: StepKind;
  /** Selected DLL folder, or "" for the bundled default. */
  value: string;
  onChange: (dir: string) => void;
}

/** The line under the select: why no version is listed yet, or what the choice means. */
function versionHelp(error: string | null, catalog: RuntimeManifest | null, versionCount: number): string {
  if (error !== null) return `Could not load versions: ${error}. The bundled DLL is used; reload the page to try again.`;
  if (catalog === null) return "Looking for installed versions…";
  return versionCount > 0 ? "Use a specific installed DLSS DLL, or the bundled one." : "Only the bundled DLL is installed.";
}

/** Lets the user pick a specific installed DLSS DLL version (or the bundled default) for a feature. */
export function VersionSelect({ feature, value, onChange }: VersionSelectProps) {
  // Per instance, not per feature: the image and video panels both render the
  // version picker for the same step, so a feature-keyed id appears twice.
  const labelId = useId();
  const helpId = useId();
  const [catalog, setCatalog] = useState<RuntimeManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .catalog()
      .then((manifest) => active && setCatalog(manifest))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, []);

  const versions = catalog?.features.find((entry) => entry.key === feature)?.versions ?? [];

  return (
    <FormControl sx={{ minWidth: 220 }}>
      <InputLabel id={labelId}>DLSS version</InputLabel>
      <Select<string> labelId={labelId} label="DLSS version" value={value} aria-describedby={helpId} onChange={(event) => onChange(event.target.value)}>
        <MenuItem value="">Bundled (default)</MenuItem>
        {versions.map((installed) => (
          <MenuItem key={installed.dir} value={installed.dir}>
            {installed.version} ({installed.source})
          </MenuItem>
        ))}
      </Select>
      <FormHelperText id={helpId}>{versionHelp(error, catalog, versions.length)}</FormHelperText>
    </FormControl>
  );
}
