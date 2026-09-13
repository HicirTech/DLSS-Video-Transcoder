import { useId, useState } from "react";
import { Button, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from "@mui/material";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import type { ProbeReport } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";
import { STORAGE_KEY, useSettings } from "../hooks/useSettings";
import { useToast } from "../hooks/useToast";
import { LogPanel } from "./LogPanel";
import { NumberField } from "./NumberField";
import { Mono, Section } from "./Section";

interface SettingsPanelProps {
  /** The last probe, which lists the GPUs a job can be sent to; null until one has run. */
  probe: ProbeReport | null;
  onProbe: () => void;
}

/** Sentinel for the automatic choice in the GPU select; the stored value for it is null. */
const AUTO_GPU = "auto";

export function SettingsPanel({ probe, onProbe }: SettingsPanelProps) {
  // useId, not a constant: every tab stays mounted, so two panels can render
  // this component at once and a fixed id would appear twice in one document.
  const gpuLabelId = useId();
  const { settings, setNr, setAdapterUuid, reset, replaceAll } = useSettings();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  // Only adapters a job would accept are offered: NVIDIA hardware with a CUDA device behind it.
  const gpus = (probe?.adapters ?? []).filter((a) => a.isNvidia && !a.software && a.cudaUuid !== null);
  const storedIsListed = settings.adapterUuid === null || gpus.some((a) => a.cudaUuid === settings.adapterUuid);

  const loadServerDefaults = async (): Promise<void> => {
    setLoading(true);
    try {
      const defaults = await api.settingsDefaults();
      // The server has no GPU preference of its own; the stored one is kept.
      replaceAll({ nr: defaults.settings, scale: defaults.scale, encode: defaults.encode, adapterUuid: settings.adapterUuid });
      toast.showSuccess("Loaded the server's default settings");
    } catch (err) {
      toast.showError(`Could not load server defaults: ${errorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack spacing={3} sx={{ maxWidth: 720 }}>
      <Section title="GPU">
        <Stack spacing={1}>
          <FormControl sx={{ maxWidth: 560 }}>
            <InputLabel id={gpuLabelId}>Run image and video jobs on</InputLabel>
            <Select<string>
              labelId={gpuLabelId}
              label="Run image and video jobs on"
              value={settings.adapterUuid ?? AUTO_GPU}
              onChange={(event) => setAdapterUuid(event.target.value === AUTO_GPU ? null : event.target.value)}
            >
              <MenuItem value={AUTO_GPU}>Automatic: the NVIDIA adapter with the most VRAM that has a CUDA device</MenuItem>
              {gpus.map((a) => (
                <MenuItem key={a.cudaUuid!} value={a.cudaUuid!}>
                  {a.name} — CUDA device {a.cudaOrdinal} ({a.cudaUuid})
                </MenuItem>
              ))}
              {storedIsListed ? null : (
                <MenuItem value={settings.adapterUuid!}>Stored choice {settings.adapterUuid} (not in the last probe)</MenuItem>
              )}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary">
            {probe
              ? gpus.length
                ? `${gpus.length} GPU${gpus.length === 1 ? "" : "s"} with a CUDA device in the last probe. The choice is kept by the device's UUID, which survives reboots; the adapter index and LUID the probe shows do not.`
                : "The last probe listed no NVIDIA adapter with a CUDA device, so only the automatic choice is available."
              : "Run the probe to list the GPUs a job can be sent to."}{" "}
            Frame generation always runs on the default device and ignores this.
          </Typography>
          {probe ? null : (
            <Button variant="outlined" onClick={onProbe} sx={{ alignSelf: "flex-start" }}>
              Run probe
            </Button>
          )}
        </Stack>
      </Section>

      <Section title="Temporal warm-up">
        <Stack spacing={1}>
          <NumberField
            label="Warm-up frames"
            value={settings.nr.warmupFrames}
            min={0}
            max={64}
            step={1}
            integer
            sx={{ width: 200 }}
            onChange={(warmupFrames) => setNr({ ...settings.nr, warmupFrames })}
          />
          <Typography variant="caption" color="text.secondary">
            Extra evaluations of the first frame so the temporal state settles before the output is taken. Images use
            this; videos settle naturally over their first frames. Range 0–64; default 4.
          </Typography>
        </Stack>
      </Section>

      <Section title="Stored settings">
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" startIcon={<RestartAltIcon />} onClick={reset}>
              Reset to defaults
            </Button>
            <Button variant="outlined" startIcon={<CloudDownloadIcon />} disabled={loading} onClick={() => void loadServerDefaults()}>
              Load server defaults
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Neural rendering, scale, encode and GPU settings persist in this browser under the localStorage key{" "}
            <Mono>{STORAGE_KEY}</Mono>. Reset to defaults restores the app's built-in defaults; Load server defaults
            fetches the server's own instead.
          </Typography>
          <LogPanel lines={JSON.stringify(settings, null, 2).split("\n")} maxHeight={320} />
        </Stack>
      </Section>
    </Stack>
  );
}
