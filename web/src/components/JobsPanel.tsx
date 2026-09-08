import { useState } from "react";
import { Alert, Box, Button, Chip, Stack } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { JobStatus } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";
import { sortJobsNewestFirst } from "../format";
import { useToast } from "../hooks/useToast";
import { JobCard } from "./JobCard";

interface JobsPanelProps {
  jobs: JobStatus[];
  now: number;
  connected: boolean;
  onRefresh: () => void;
}

export function JobsPanel({ jobs, now, connected, onRefresh }: JobsPanelProps) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());

  const cancel = async (id: string): Promise<void> => {
    setCancelling((current) => new Set(current).add(id));
    try {
      await api.cancelJob(id);
    } catch (err) {
      toast.showError(`Could not cancel ${id}: ${errorMessage(err)}`);
    } finally {
      setCancelling((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const sorted = sortJobsNewestFirst(jobs);
  const running = jobs.filter((job) => job.state === "running").length;
  const queued = jobs.filter((job) => job.state === "queued").length;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Chip label={`${running} running`} color={running > 0 ? "info" : "default"} variant="outlined" />
        <Chip label={`${queued} queued`} variant="outlined" />
        <Chip label={`${jobs.length} total`} variant="outlined" />
        <Box sx={{ flex: 1 }} />
        <Chip
          label={connected ? "live updates" : "reconnecting..."}
          color={connected ? "success" : "warning"}
          variant="outlined"
        />
        <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
          Refresh
        </Button>
      </Stack>

      {sorted.length === 0 ? (
        <Alert severity="info" variant="outlined">
          No jobs yet. Start one from the Image or Video tab.
        </Alert>
      ) : (
        sorted.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            now={now}
            onCancel={(id) => void cancel(id)}
            cancelling={cancelling.has(job.id)}
          />
        ))
      )}
    </Stack>
  );
}
