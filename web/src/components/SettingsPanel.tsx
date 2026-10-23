import { useId, useState } from "react";
import { Button, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from "@mui/material";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { AUTO_GPU_CHOICE, DEFAULT_WARMUP_FRAMES, FRAME_GEN_GPU_CHOICE, type ProbeReport, SETTING_RANGES } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";
import { STORAGE_KEY, useSettings, withServerDefaults } from "../hooks/useSettings";
import { useToast } from "../hooks/useToast";
import { LogPanel } from "./LogPanel";
import { NumberField } from "./NumberField";
import { Mono, Section } from "./Section";

interface SettingsPanelProps {
  /** The last probe, which lists the GPUs a job can be sent to; null until one has run. */
  probe: ProbeReport | null;
  probing: boolean;
  onProbe: () => void;
}

/** Sentinel for the automatic choice in the GPU select; the stored value for it is null. */
const AUTO_GPU = "auto";

export function SettingsPanel({ probe, probing, onProbe }: SettingsPanelProps) {
  const gpuLabelId = useId();
  const { settings, update, reset, replaceAll } = useSettings();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  // Only adapters a job would accept are offered; the probe judged that by the rule jobs apply.
  const gpus = (probe?.adapters ?? []).filter((a) => a.eligible && a.cudaUuid !== null);
  const storedIsListed = settings.adapterUuid === null || gpus.some((a) => a.cudaUuid === settings.adapterUuid);

  const loadServerDefaults = async (): Promise<void> => {
    setLoading(true);
    try {
      // The server has no GPU preference or step switches of its own; the stored ones are kept.
      replaceAll(withServerDefaults(settings, await api.settingsDefaults()));
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
            <InputLabel id={gpuLabelId}>Run Super Resolution and Neural Rendering on</InputLabel>
            <Select<string>
              labelId={gpuLabelId}
              label="Run Super Resolution and Neural Rendering on"
              value={settings.adapterUuid ?? AUTO_GPU}
              onChange={(event) => update({ adapterUuid: event.target.value === AUTO_GPU ? null : event.target.value })}
            >
              <MenuItem value={AUTO_GPU}>Automatic: {AUTO_GPU_CHOICE}</MenuItem>
              {gpus.map((a) => (
                <MenuItem key={a.cudaUuid!} value={a.cudaUuid!}>
                  {a.name} — CUDA device {a.cudaOrdinal} ({a.cudaUuid})
                </MenuItem>
              ))}
              {storedIsListed ? null : (
                <MenuItem value={settings.adapterUuid!}>
                  Stored choice {settings.adapterUuid} ({probe ? "not in the last probe" : "run the probe to confirm it is present"})
                </MenuItem>
              )}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary">
            {probe
              ? gpus.length
                ? `${gpus.length} GPU${gpus.length === 1 ? "" : "s"} with a CUDA device in the last probe. The choice is kept by the device's UUID, which survives reboots; the adapter index and LUID the probe shows do not.`
                : "The last probe listed no NVIDIA adapter with a CUDA device, so only the automatic choice is available."
              : "Run the probe to list the GPUs a job can be sent to."}{" "}
            A job with no step switched on copies its frames on this GPU too. Frame generation ignores this:{" "}
            {FRAME_GEN_GPU_CHOICE}.
          </Typography>
          {probe ? null : (
            <Button variant="outlined" disabled={probing} onClick={onProbe} sx={{ alignSelf: "flex-start" }}>
              {probing ? "Probing..." : "Run probe"}
            </Button>
          )}
        </Stack>
      </Section>

      <Section title="Temporal warm-up">
        <Stack spacing={1}>
          <NumberField
            label="Warm-up frames"
            value={settings.warmupFrames}
            {...SETTING_RANGES.warmupFrames}
            step={1}
            integer
            sx={{ width: 200 }}
            onChange={(warmupFrames) => update({ warmupFrames })}
          />
          <Typography variant="caption" color="text.secondary">
            Image jobs only: passes over the still before the one that is kept, each through every step switched on,
            so the temporal state of Super Resolution and Neural Rendering settles. Videos settle over their first
            frames. Range {SETTING_RANGES.warmupFrames.min}–{SETTING_RANGES.warmupFrames.max}; default {DEFAULT_WARMUP_FRAMES}.
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
            The steps each tab runs, their settings, the resize, encode and GPU settings persist in this browser under
            the localStorage key <Mono>{STORAGE_KEY}</Mono>. Reset to defaults restores the app's built-in defaults;
            Load server defaults fetches the server's own instead, keeping the step switches and the GPU.
          </Typography>
          <LogPanel lines={JSON.stringify(settings, null, 2).split("\n")} maxHeight={320} />
        </Stack>
      </Section>
    </Stack>
  );
}
