import { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import type { JobStatus } from "../../../src/server/api-types";
import { outputSizeLimits } from "../../../src/server/output-size";
import { unusedSettings } from "../../../src/server/settings-in-use";
import { api } from "../api";
import { useJobRunner } from "../hooks/useJobRunner";
import { useMediaInfo } from "../hooks/useMediaInfo";
import { type ImageStepKind, useSettings } from "../hooks/useSettings";
import { formatSize, planJob, planStages, STEP_TITLES } from "../job-plan";
import { imageRequest } from "../job-requests";
import { CompareView } from "./CompareView";
import { JobCard } from "./JobCard";
import { InputPathField, OutputPathField } from "./JobFormFields";
import { MediaSummary } from "./MediaSummary";
import { NrSettingsEditor } from "./NrSettingsEditor";
import { PlanLine } from "./PlanLine";
import { ScaleSettingsEditor } from "./ScaleSettingsEditor";
import { Section, UnusedNote } from "./Section";
import { StepCard } from "./StepCard";
import { SuperResolutionEditor } from "./SuperResolutionEditor";
import { VersionSelect } from "./VersionSelect";

interface ImagePanelProps {
  jobs: JobStatus[];
  now: number;
}

/** The version folder each step loads, chosen on the form only: the installed versions can change between sessions. */
type DllDirs = Record<ImageStepKind, string>;
const BUNDLED_DLLS: DllDirs = { sr: "", nr: "" };

/** The Image tab: a PNG, Super Resolution and Neural Rendering on their own switches, and the output, with a before/after view. */
export function ImagePanel({ jobs, now }: ImagePanelProps) {
  const { settings, update } = useSettings();
  const runner = useJobRunner(jobs);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [dllDirs, setDllDirs] = useState<DllDirs>(BUNDLED_DLLS);
  const media = useMediaInfo(input);
  const source = media.info?.kind === "image" ? media.info : null;
  // A still has no frames to generate between.
  const steps = { ...settings.imageSteps, fg: false };
  const plan = planJob({ kind: "image", input, source, steps, srScale: settings.superResolution.scale, resize: settings.resize, container: settings.encode.container });
  const unused = unusedSettings(steps);
  const outputSize = plan.outputSize ? formatSize(plan.outputSize) : null;
  // Image jobs read PNG only: a file GET /api/media found to be something else would fail the job.
  const notPng = media.info !== null && media.info.kind !== "image";
  const canRun = input.trim() !== "" && !runner.submitting && plan.srProblem === null && !notPng;

  const setStep = (step: ImageStepKind, on: boolean): void => update({ imageSteps: { ...settings.imageSteps, [step]: on } });
  const setDllDir = (step: ImageStepKind) => (dir: string): void => setDllDirs((current) => ({ ...current, [step]: dir }));
  const run = (): void => void runner.submit(imageRequest({ input, output, dllDirs }, settings));

  const passes = plan.steps.length ? `, ${settings.warmupFrames + 1} passes` : "";
  const stages = planStages({ plan, source, srScale: settings.superResolution.scale, resize: settings.resize, frameGenTarget: "", writer: `PNG${passes}` });
  const job = runner.job;
  const showCompare = job !== null && job.state === "done" && job.output !== null;

  return (
    <Stack spacing={3}>
      <Section title="Source">
        <Stack spacing={1}>
          <InputPathField kind="image" value={input} onChange={setInput} />
          <MediaSummary media={media} expected="image" />
        </Stack>
      </Section>

      <Section title="Steps" action={<Typography variant="caption" color="text.secondary">Switch on what to run; they always run in this order.</Typography>}>
        <Stack spacing={1.5}>
          <StepCard
            order={1}
            title={STEP_TITLES.sr}
            summary="Upscales the image with DLSS Super Resolution, from the source size to the output size."
            on={steps.sr}
            onToggle={(on) => setStep("sr", on)}
            result={source && outputSize ? `${formatSize(source)} → ${outputSize}` : null}
            problem={plan.srProblem}
          >
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
              <SuperResolutionEditor value={settings.superResolution} kind="image" onChange={(superResolution) => update({ superResolution })} />
              <VersionSelect feature="sr" value={dllDirs.sr} onChange={setDllDir("sr")} />
            </Stack>
          </StepCard>

          <StepCard
            order={2}
            title={STEP_TITLES.nr}
            summary="Enhances the image at the output size with DLSS Neural Rendering; no upscale."
            on={steps.nr}
            onToggle={(on) => setStep("nr", on)}
            result={outputSize ? `at ${outputSize}` : null}
          >
            <Stack spacing={2}>
              <NrSettingsEditor value={settings.neuralRendering} onChange={(neuralRendering) => update({ neuralRendering })} />
              <VersionSelect feature="nr" value={dllDirs.nr} onChange={setDllDir("nr")} />
            </Stack>
          </StepCard>
        </Stack>
      </Section>

      <Section title="Output">
        <Stack spacing={2.5}>
          <OutputPathField value={output} defaultName={plan.defaultOutputName} onChange={setOutput} />
          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", mb: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Resize
              </Typography>
              <Typography variant="caption" color="text.secondary">
                bilinear, when Super Resolution is off
              </Typography>
              <UnusedNote reason={unused.resize} />
            </Stack>
            <ScaleSettingsEditor value={settings.resize} limits={outputSizeLimits("resize")} disabled={unused.resize !== null} onChange={(resize) => update({ resize })} />
          </Box>
        </Stack>
      </Section>

      <PlanLine stages={stages} output={output.trim() || plan.defaultOutputName} />

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
            {showCompare && job.output ? <CompareView beforeSrc={api.fileUrl(job.input)} afterSrc={api.fileUrl(job.output)} /> : null}
          </Stack>
        </Section>
      ) : null}
    </Stack>
  );
}
