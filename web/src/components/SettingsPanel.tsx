import { useState } from "react";
import { Button, Stack, Typography } from "@mui/material";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { api } from "../api";
import { errorMessage } from "../errors";
import { STORAGE_KEY, useSettings } from "../hooks/useSettings";
import { useToast } from "../hooks/useToast";
import { LogPanel } from "./LogPanel";
import { NumberField } from "./NumberField";
import { Mono, Section } from "./Section";

export function SettingsPanel() {
  const { settings, setNr, reset, replaceAll } = useSettings();
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  const loadServerDefaults = async (): Promise<void> => {
    setLoading(true);
    try {
      const defaults = await api.settingsDefaults();
      replaceAll({ nr: defaults.settings, scale: defaults.scale, encode: defaults.encode });
      toast.showSuccess("Loaded the server's default settings");
    } catch (err) {
      toast.showError(`Could not load server defaults: ${errorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack spacing={3} sx={{ maxWidth: 720 }}>
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
            Neural rendering, scale and encode settings persist in this browser under the localStorage key{" "}
            <Mono>{STORAGE_KEY}</Mono>. Reset to defaults restores the app's built-in defaults; Load server defaults
            fetches the server's own instead.
          </Typography>
          <LogPanel lines={JSON.stringify(settings, null, 2).split("\n")} maxHeight={320} />
        </Stack>
      </Section>
    </Stack>
  );
}
