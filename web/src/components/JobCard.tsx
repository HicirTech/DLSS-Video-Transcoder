import { useState } from "react";
import { Alert, Box, Button, Chip, Collapse, IconButton, LinearProgress, Paper, Stack, Typography } from "@mui/material";
import CancelIcon from "@mui/icons-material/Cancel";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ImageIcon from "@mui/icons-material/Image";
import MovieIcon from "@mui/icons-material/Movie";
import type { EngineKind, JobState, JobStatus } from "../../../src/server/api-types";
import { baseName, formatDuration, formatTime, isJobActive, jobElapsedMs } from "../format";
import { LogPanel } from "./LogPanel";
import { Mono } from "./Section";
import { StateChip } from "./StatusChips";

interface JobCardProps {
  job: JobStatus;
  /** Clock value from useNow(); keeps the elapsed time ticking. */
  now: number;
  onCancel?: (id: string) => void;
  cancelling?: boolean;
  defaultExpanded?: boolean;
}

type ProgressColor = "primary" | "success" | "error" | "warning" | "inherit";

// Record<EngineKind, ...>: a new engine without a label is a build error, not a wrong chip.
const ENGINE_LABELS: Record<EngineKind, string> = {
  sr: "super resolution",
  nr: "neural rendering",
  bypass: "bypass (passthrough)",
};

const PROGRESS_COLORS: Record<JobState, ProgressColor> = {
  queued: "inherit",
  running: "primary",
  done: "success",
  failed: "error",
  cancelled: "warning",
};

/** One job: header with state and actions, progress bar, counters, error and a collapsible following log. */
export function JobCard({ job, now, onCancel, cancelling = false, defaultExpanded = false }: JobCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const active = isJobActive(job);
  const elapsed = jobElapsedMs(job, now);
  const percent = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
  const indeterminate = job.state === "running" && job.progress <= 0 && job.framesTotal === null;

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        {job.kind === "image" ? <ImageIcon fontSize="small" color="action" /> : <MovieIcon fontSize="small" color="action" />}
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }} title={job.input}>
          {baseName(job.input)}
        </Typography>
        <StateChip state={job.state} />
        <Chip label={ENGINE_LABELS[job.engine]} variant="outlined" />
        <Box sx={{ flex: 1 }} />
        <Mono dim>{job.id}</Mono>
        {active && onCancel ? (
          <Button color="warning" startIcon={<CancelIcon />} disabled={cancelling} onClick={() => onCancel(job.id)}>
            Cancel
          </Button>
        ) : null}
        <IconButton aria-label={expanded ? "Hide log" : "Show log"} onClick={() => setExpanded((value) => !value)}>
          <ExpandMoreIcon
            fontSize="small"
            sx={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms" }}
          />
        </IconButton>
      </Stack>

      <LinearProgress
        variant={indeterminate ? "indeterminate" : "determinate"}
        value={percent}
        color={PROGRESS_COLORS[job.state]}
        sx={{ my: 1, height: 6, borderRadius: 3 }}
      />

      <Stack
        direction="row"
        spacing={2}
        useFlexGap
        sx={{ flexWrap: "wrap", color: "text.secondary", fontSize: 12, alignItems: "baseline" }}
      >
        <span>{percent}%</span>
        <span>
          frames {job.framesDone}
          {job.framesTotal !== null ? ` / ${job.framesTotal}` : ""}
        </span>
        <span>{job.fps !== null ? `${job.fps.toFixed(1)} fps` : "fps -"}</span>
        <span>elapsed {elapsed !== null ? formatDuration(elapsed) : "-"}</span>
        <span>created {formatTime(job.createdAt)}</span>
        <Box component="span" sx={{ flex: 1, minWidth: 140, color: "text.primary" }} title={job.message}>
          {job.message}
        </Box>
      </Stack>

      {job.output ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }} title={job.output}>
          output: <Mono>{job.output}</Mono>
        </Typography>
      ) : null}
      {job.error ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {job.error}
        </Alert>
      ) : null}

      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ mt: 1 }}>
          <LogPanel lines={job.log} />
        </Box>
      </Collapse>
    </Paper>
  );
}
