import { useState } from "react";
import { Alert, Box, Button, FormHelperText, Link, Stack, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import { FRAME_GEN_CONTAINER, type JobStatus, type StepKind, type ToolsReport } from "../../../src/server/api-types";
import { nvencLimitExceeded } from "../../../src/server/output-size";
import { unusedSettings } from "../../../src/server/settings-in-use";
import { api } from "../api";
import { formatFps, rateValue } from "../format";
import { useJobRunner } from "../hooks/useJobRunner";
import { useMediaInfo } from "../hooks/useMediaInfo";
import { useSettings } from "../hooks/useSettings";
import { formatSize, frameGenOutputFps, planJob, planStages, STEP_TITLES } from "../job-plan";
import { videoRequest } from "../job-requests";
import { CODEC_LABELS, CONTAINER_LABELS, EncodeSettingsEditor } from "./EncodeSettingsEditor";
import { FrameGenEditor } from "./FrameGenEditor";
import { JobCard } from "./JobCard";
import { InputPathField, OutputPathField } from "./JobFormFields";
import { MediaSummary } from "./MediaSummary";
import { NrSettingsEditor } from "./NrSettingsEditor";
import { PlanLine } from "./PlanLine";
import { ResizeField } from "./ResizeField";
import { Mono, Section } from "./Section";
import { StepCard } from "./StepCard";
import { SuperResolutionEditor } from "./SuperResolutionEditor";
import { ToolsBanner } from "./ToolsBanner";
import { VersionSelect } from "./VersionSelect";

interface VideoPanelProps {
  jobs: JobStatus[];
  now: number;
  tools: ToolsReport | null;
  toolsError: string | null;
}

/** The version folder each step loads, chosen on the form only: the installed versions can change between sessions. */
type DllDirs = Record<StepKind, string>;
const BUNDLED_DLLS: DllDirs = { sr: "", nr: "", fg: "" };

/**
 * The Video tab: a source, the three steps in the order they run, each on its own switch, and the output. The
 * plan line above Run says what the job will do with the source as it stands.
 */
export function VideoPanel({ jobs, now, tools, toolsError }: VideoPanelProps) {
  const { settings, update } = useSettings();
  const runner = useJobRunner(jobs);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [dllDirs, setDllDirs] = useState<DllDirs>(BUNDLED_DLLS);
  const media = useMediaInfo(input);
  const source = media.info?.kind === "video" ? media.info : null;
  const steps = settings.videoSteps;
  const plan = planJob({ kind: "video", input, source, steps, srScale: settings.superResolution.scale, resize: settings.resize, container: settings.encode.container });
  const unused = unusedSettings(steps);
  const sourceFps = source ? rateValue(source.nominalFps) : null;
  const outputFps = frameGenOutputFps(settings.frameGen, source?.nominalFps ?? null);
  const outputSize = plan.outputSize ? formatSize(plan.outputSize) : null;
  const container = steps.fg ? FRAME_GEN_CONTAINER : settings.encode.container;
  const canRun = input.trim() !== "" && !runner.submitting && plan.srProblem === null;

  const setStep = (step: StepKind, on: boolean): void => update({ videoSteps: { ...steps, [step]: on } });
  const setDllDir = (step: StepKind) => (dir: string): void => setDllDirs((current) => ({ ...current, [step]: dir }));
  const run = (): void => void runner.submit(videoRequest({ input, output, dllDirs }, settings));

  // Past its NVENC encoder's longest side the job encodes the same format on the CPU (resolveEncodeCodec).
  const onCpu = plan.outputSize !== null && nvencLimitExceeded(settings.encode.codec, plan.outputSize) !== null;
  const stages = planStages({
    plan,
    source,
    srScale: settings.superResolution.scale,
    resize: settings.resize,
    frameGenTarget: outputFps !== null ? `${formatFps(outputFps)} fps` : `${settings.frameGen.multiplier}× the source rate`,
    writer: `${onCpu ? "CPU encode" : CODEC_LABELS[settings.encode.codec]} in ${CONTAINER_LABELS[container]}`,
  });
  const job = runner.job;

  return (
    <Stack spacing={3}>
      <ToolsBanner tools={tools} toolsError={toolsError} />

      <Section title="Source">
        <Stack spacing={1}>
          <InputPathField kind="video" value={input} onChange={setInput} />
          <MediaSummary media={media} expected="video" />
        </Stack>
      </Section>

      <Section title="Steps" action={<Typography variant="caption" color="text.secondary">Switch on what to run; they always run in this order.</Typography>}>
        <Stack spacing={1.5}>
          <StepCard
            order={1}
            title={STEP_TITLES.sr}
            summary="Upscales every frame with DLSS Super Resolution, from the source size to the output size."
            on={steps.sr}
            onToggle={(on) => setStep("sr", on)}
            result={source && outputSize ? `${formatSize(source)} → ${outputSize}` : null}
            problem={plan.srProblem}
          >
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
              <SuperResolutionEditor value={settings.superResolution} kind="video" onChange={(superResolution) => update({ superResolution })} />
              <VersionSelect feature="sr" value={dllDirs.sr} onChange={setDllDir("sr")} />
            </Stack>
          </StepCard>

          <StepCard
            order={2}
            title={STEP_TITLES.nr}
            summary="Enhances every frame at the output size with DLSS Neural Rendering; no upscale."
            on={steps.nr}
            onToggle={(on) => setStep("nr", on)}
            result={outputSize ? `at ${outputSize}` : null}
          >
            <Stack spacing={2}>
              <NrSettingsEditor value={settings.neuralRendering} onChange={(neuralRendering) => update({ neuralRendering })} />
              <VersionSelect feature="nr" value={dllDirs.nr} onChange={setDllDir("nr")} />
            </Stack>
          </StepCard>

          <StepCard
            order={3}
            title={STEP_TITLES.fg}
            summary="Interpolates the processed frames to a higher frame rate with DLSS Frame Generation."
            on={steps.fg}
            onToggle={(on) => setStep("fg", on)}
            result={sourceFps !== null && outputFps !== null ? `${formatFps(sourceFps)} → ${formatFps(outputFps)} fps` : null}
          >
            <Stack spacing={2}>
              <FrameGenEditor value={settings.frameGen} onChange={(frameGen) => update({ frameGen })} />
              <VersionSelect feature="fg" value={dllDirs.fg} onChange={setDllDir("fg")} />
              {unused.gpu !== null ? <FormHelperText>{unused.gpu}</FormHelperText> : null}
            </Stack>
          </StepCard>
        </Stack>
      </Section>

      <Section title="Output">
        <Stack spacing={2.5}>
          <OutputPathField value={output} defaultName={plan.defaultOutputName} onChange={setOutput} />
          <ResizeField
            value={settings.resize}
            method="lanczos, in the decode"
            unusedReason={unused.resize}
            outputSize={plan.outputSize}
            onChange={(resize) => update({ resize })}
          />
          <EncodeSettingsEditor
            value={settings.encode}
            fixedContainer={steps.fg ? { container: FRAME_GEN_CONTAINER, reason: "Frame generation always writes MP4" } : undefined}
            outputSize={plan.outputSize}
            onChange={(encode) => update({ encode })}
          />
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
