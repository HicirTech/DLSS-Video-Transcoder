import { useState } from "react";
import { Alert, AlertTitle, Box, Button, Chip, Stack, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { JobStatus } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";
import { sortJobsNewestFirst } from "../format";
import type { JobsFeedStatus } from "../hooks/useJobsFeed";
import { useToast } from "../hooks/useToast";
import { JobCard } from "./JobCard";

interface JobsPanelProps {
  jobs: JobStatus[];
  now: number;
  status: JobsFeedStatus;
  onRefresh: () => void;
}

/** What the tab says while it lists no job: still loading, or truly none. A failed load has its own alert. */
function NoJobs({ status }: { status: JobsFeedStatus }) {
  if (status.kind === "failed") return null;
  if (status.kind === "loading") {
    return (
      <Typography variant="body2" color="text.secondary" role="status">
        Loading jobs…
      </Typography>
    );
  }
  return (
    <Alert severity="info" variant="outlined" role="status">
      No jobs yet. Start one from the Image or Video tab.
    </Alert>
  );
}

/** The Jobs tab: every job newest first, with cancel and a manual refresh. */
export function JobsPanel({ jobs, now, status, onRefresh }: JobsPanelProps) {
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
        <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
          Refresh
        </Button>
      </Stack>

      {status.kind === "failed" ? (
        <Alert severity="error" variant="outlined">
          <AlertTitle>Could not load the job list</AlertTitle>
          <Box>{status.error}</Box>
          <Box>Use Refresh to try again{sorted.length > 0 ? "; the jobs below are from the last list that loaded." : "."}</Box>
        </Alert>
      ) : null}

      {sorted.length === 0 ? (
        <NoJobs status={status} />
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
