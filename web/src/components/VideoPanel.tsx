import { useState } from "react";
import { Alert, Box, Button, Chip, Link, Stack, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import type { EngineKind, JobRequest, JobStatus, MotionKind, ToolsReport } from "../../../src/server/api-types";
import { api } from "../api";
import { useJobRunner } from "../hooks/useJobRunner";
import { useSettings } from "../hooks/useSettings";
import { EncodeSettingsEditor } from "./EncodeSettingsEditor";
import { JobCard } from "./JobCard";
import { EngineSelect, MotionSelect, PathFields } from "./JobFormFields";
import { NrSettingsEditor } from "./NrSettingsEditor";
import { ScaleSettingsEditor } from "./ScaleSettingsEditor";
import { Mono, Section } from "./Section";

interface VideoPanelProps {
  jobs: JobStatus[];
  now: number;
  tools: ToolsReport | null;
  toolsError: string | null;
}

function ToolsBanner({ tools, toolsError }: { tools: ToolsReport | null; toolsError: string | null }) {
  if (toolsError) {
    return (
      <Alert severity="info" variant="outlined">
        Could not query /api/tools ({toolsError}); ffmpeg availability is unknown.
      </Alert>
    );
  }
  if (!tools) return null;
  if (tools.ffmpeg.path === null) {
    return (
      <Alert severity="warning">
        ffmpeg was not found on this machine{tools.ffprobe.path === null ? " (ffprobe is missing as well)" : ""}. Video jobs
        need it to decode frames and encode the result, so they will fail until ffmpeg is installed and on PATH.
      </Alert>
    );
  }
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
      <Chip label={`ffmpeg ${tools.ffmpeg.version ?? ""}`.trim()} color="success" variant="outlined" />
      <Chip
        label={tools.ffprobe.path ? `ffprobe ${tools.ffprobe.version ?? ""}`.trim() : "ffprobe missing"}
        color={tools.ffprobe.path ? "success" : "warning"}
        variant="outlined"
      />
      <Chip
        label={tools.nvenc === null ? "NVENC unknown" : tools.nvenc ? "NVENC available" : "NVENC unavailable"}
        color={tools.nvenc ? "success" : "default"}
        variant="outlined"
      />
      <Typography variant="caption" color="text.secondary">
        <Mono dim>{tools.ffmpeg.path}</Mono>
      </Typography>
    </Stack>
  );
}

export function VideoPanel({ jobs, now, tools, toolsError }: VideoPanelProps) {
  const { settings, setNr, setScale, setEncode } = useSettings();
  const runner = useJobRunner(jobs);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [engine, setEngine] = useState<EngineKind>("nr");
  const [motion, setMotion] = useState<MotionKind>("flow");

  const canRun = input.trim() !== "" && !runner.submitting;

  const run = (): void => {
    const request: JobRequest = {
      kind: "video",
      input: input.trim(),
      engine,
      motion,
      settings: settings.nr,
      scale: settings.scale,
      encode: settings.encode,
    };
    if (output.trim() !== "") request.output = output.trim();
    void runner.submit(request);
  };

  const job = runner.job;

  return (
    <Stack spacing={3}>
      <ToolsBanner tools={tools} toolsError={toolsError} />

      <Section title="Source and output">
        <PathFields
          kind="video"
          input={input}
          output={output}
          onInputChange={setInput}
          onOutputChange={setOutput}
        />
      </Section>

      <Section title="Engine, motion and output size">
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
          <EngineSelect value={engine} onChange={setEngine} />
          <MotionSelect value={motion} onChange={setMotion} />
          <ScaleSettingsEditor value={settings.scale} onChange={setScale} />
        </Stack>
      </Section>

      <Section title="Encoding">
        <EncodeSettingsEditor value={settings.encode} onChange={setEncode} />
      </Section>

      <Section
        title="Neural rendering"
        action={
          engine === "bypass" ? (
            <Typography variant="caption" color="warning.main">
              Ignored by the bypass engine
            </Typography>
          ) : undefined
        }
      >
        <NrSettingsEditor value={settings.nr} onChange={setNr} />
      </Section>

      <Box>
        <Button variant="contained" size="medium" startIcon={<PlayArrowIcon />} disabled={!canRun} onClick={run}>
          {runner.submitting ? "Starting..." : "Run"}
        </Button>
      </Box>

      {job ? (
        <Section
          title="Current job"
          action={
            <Button variant="text" onClick={runner.clear}>
              Dismiss
            </Button>
          }
        >
          <Stack spacing={2}>
            <JobCard job={job} now={now} onCancel={() => void runner.cancel()} cancelling={runner.cancelling} />
            {job.state === "done" && job.output ? (
              <Alert severity="success" variant="outlined">
                Finished. Output written to <Mono>{job.output}</Mono>{" "}
                <Link href={api.fileUrl(job.output)} target="_blank" rel="noreferrer">
                  (open)
                </Link>
              </Alert>
            ) : null}
          </Stack>
        </Section>
      ) : null}
    </Stack>
  );
}
