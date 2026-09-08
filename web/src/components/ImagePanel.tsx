import { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import type { EngineKind, JobRequest, JobStatus } from "../../../src/server/api-types";
import { api } from "../api";
import { useJobRunner } from "../hooks/useJobRunner";
import { useSettings } from "../hooks/useSettings";
import { CompareView } from "./CompareView";
import { JobCard } from "./JobCard";
import { EngineSelect, PathFields } from "./JobFormFields";
import { NrSettingsEditor } from "./NrSettingsEditor";
import { ScaleSettingsEditor } from "./ScaleSettingsEditor";
import { Section } from "./Section";
import { VersionSelect } from "./VersionSelect";

interface ImagePanelProps {
  jobs: JobStatus[];
  now: number;
}

export function ImagePanel({ jobs, now }: ImagePanelProps) {
  const { settings, setNr, setScale } = useSettings();
  const runner = useJobRunner(jobs);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [engine, setEngine] = useState<EngineKind>("nr");
  const [dllDir, setDllDir] = useState("");

  const canRun = input.trim() !== "" && !runner.submitting;
  const usesDlss = engine === "sr" || engine === "nr";

  const changeEngine = (next: EngineKind): void => {
    setEngine(next);
    setDllDir(""); // a version chosen for one feature does not apply to another
  };

  const run = (): void => {
    const request: JobRequest = {
      kind: "image",
      input: input.trim(),
      engine,
      motion: "none",
      settings: settings.nr,
      scale: settings.scale,
    };
    if (usesDlss && dllDir !== "") request.dllDir = dllDir;
    if (output.trim() !== "") request.output = output.trim();
    void runner.submit(request);
  };

  const job = runner.job;
  const showCompare = job !== null && job.state === "done" && job.output !== null;

  return (
    <Stack spacing={3}>
      <Section title="Source and output">
        <PathFields
          kind="image"
          input={input}
          output={output}
          onInputChange={setInput}
          onOutputChange={setOutput}
        />
      </Section>

      <Section title="Engine and output size">
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
          <EngineSelect value={engine} onChange={changeEngine} />
          {usesDlss ? <VersionSelect featureId={engine === "sr" ? 1 : 18} value={dllDir} onChange={setDllDir} /> : null}
          <ScaleSettingsEditor value={settings.scale} onChange={setScale} />
        </Stack>
      </Section>

      <Section
        title="Neural rendering"
        action={
          engine !== "nr" ? (
            <Typography variant="caption" color="warning.main">
              {engine === "sr"
                ? "Not used by Super Resolution — it upscales to the output size above"
                : "Not used by the bypass engine (plain passthrough copy)"}
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
            {showCompare && job.output ? (
              <CompareView beforeSrc={api.fileUrl(job.input)} afterSrc={api.fileUrl(job.output)} />
            ) : null}
          </Stack>
        </Section>
      ) : null}
    </Stack>
  );
}
