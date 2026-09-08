import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { ProbeReport } from "../../../src/server/api-types";
import { formatDateTime } from "../format";
import { Section } from "./Section";
import { AdaptersTable } from "./probe/AdaptersTable";
import { DriverCard } from "./probe/DriverCard";
import { FeaturesTable } from "./probe/FeaturesTable";
import { ForwarderSection } from "./probe/ForwarderSection";
import { RawLog } from "./probe/RawLog";
import { RuntimeFilesTable } from "./probe/RuntimeFilesTable";
import { VerdictCard } from "./probe/VerdictCard";

interface ProbePanelProps {
  probe: ProbeReport | null;
  probing: boolean;
  onProbe: () => void;
}

export function ProbePanel({ probe, probing, onProbe }: ProbePanelProps) {
  return (
    <Stack spacing={2.5}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        <Button
          variant="contained"
          startIcon={probe ? <RefreshIcon /> : <PlayArrowIcon />}
          disabled={probing}
          onClick={onProbe}
        >
          {probing ? "Probing..." : probe ? "Run probe again" : "Run probe"}
        </Button>
        <Typography variant="body2" color="text.secondary">
          Checks whether this machine can run DLSS neural rendering: it lists your display adapters (GPUs), creates a
          Direct3D 12 device, starts NVIDIA&apos;s NGX runtime, and confirms the neural rendering feature and its support
          files are available. Takes a few seconds.
        </Typography>
      </Box>
      {probing ? <LinearProgress /> : null}

      {!probe && !probing ? (
        <Alert severity="info" variant="outlined">
          No probe has run yet in this session. Run it to check DLSS neural rendering support; the status chip in the
          title bar will update with the result.
        </Alert>
      ) : null}

      {probe ? (
        <>
          <VerdictCard verdict={probe.verdict} />
          <Typography variant="caption" color="text.secondary">
            Generated {formatDateTime(probe.generatedAt)} on {probe.platform.os}, Bun {probe.platform.bun}
            {probe.ok ? "" : " - the probe reported a problem while running"}
          </Typography>

          <Section title="Adapters">
            <AdaptersTable adapters={probe.adapters} selected={probe.selectedAdapter} />
          </Section>
          <Section title="Driver and NGX core">
            <DriverCard driver={probe.driver} device={probe.device} ngxInit={probe.ngxInit} capabilities={probe.capabilities} />
          </Section>
          <Section title="NGX features">
            <FeaturesTable features={probe.features} />
          </Section>
          <Section title="Runtime files">
            <RuntimeFilesTable folder={probe.runtime.folder} files={probe.runtime.files} />
          </Section>
          <Section title="NGX bridge self-test">
            <ForwarderSection forwarder={probe.forwarder} />
          </Section>
          <Section title="Raw log">
            <RawLog lines={probe.log} />
          </Section>
        </>
      ) : null}
    </Stack>
  );
}
