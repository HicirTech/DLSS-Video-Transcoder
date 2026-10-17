import { Fragment } from "react";
import { Paper, Stack, Typography } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { Mono } from "./Section";

interface PlanLineProps {
  /** What the job does, stage by stage (planStages). */
  stages: string[];
  /** Where it writes: the output path given, or the default name next to the input; null before there is an input. */
  output: string | null;
}

/** The job the form describes, in one line: what Run would start. */
export function PlanLine({ stages, output }: PlanLineProps) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="subtitle2" component="span" sx={{ color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.6, fontSize: 11, mr: 0.5 }}>
          Plan
        </Typography>
        {stages.map((stage, index) => (
          <Fragment key={stage}>
            {index > 0 ? <ArrowForwardIcon sx={{ fontSize: 14 }} color="action" /> : null}
            <Typography variant="body2" component="span">
              {stage}
            </Typography>
          </Fragment>
        ))}
      </Stack>
      {output ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          writes <Mono>{output}</Mono>
        </Typography>
      ) : null}
    </Paper>
  );
}
