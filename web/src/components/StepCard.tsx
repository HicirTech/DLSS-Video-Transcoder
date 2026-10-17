import type { ReactNode } from "react";
import { Alert, Box, Collapse, FormControlLabel, Paper, Stack, Switch, Typography } from "@mui/material";

interface StepCardProps {
  /** Where the step runs in the job, from 1: the steps always run in this order. */
  order: number;
  title: string;
  /** What the step does, in one line; shown whether it is on or off. */
  summary: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  /** What the step makes of the frames with the current settings, e.g. "1280×720 → 1920×1080"; shown while it is on. */
  result?: string | null;
  /** Why the job cannot run with this step as set; shown while it is on, and the form holds back Run. */
  problem?: string | null;
  /** The step's settings, shown while it is on. */
  children: ReactNode;
}

/** One processing step of a job: its own switch, and its settings below while it is on. */
export function StepCard({ order, title, summary, on, onToggle, result, problem, children }: StepCardProps) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: on ? "primary.main" : "divider" }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <FormControlLabel
          sx={{ mr: 0 }}
          control={<Switch checked={on} onChange={(_event, checked) => onToggle(checked)} />}
          label={
            <Typography variant="subtitle2" component="span" sx={{ fontWeight: 600 }}>
              {order}. {title}
            </Typography>
          }
        />
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
          {summary}
        </Typography>
        {on && result ? (
          <Typography variant="body2" color="primary" sx={{ fontWeight: 600 }}>
            {result}
          </Typography>
        ) : null}
      </Stack>
      <Collapse in={on}>
        <Box sx={{ pt: 2 }}>
          {children}
          {problem ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {problem}
            </Alert>
          ) : null}
        </Box>
      </Collapse>
    </Paper>
  );
}
