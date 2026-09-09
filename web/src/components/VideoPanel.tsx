import { useState } from "react";
import { Alert, Box, Button, Chip, FormControl, FormControlLabel, FormHelperText, InputLabel, Link, MenuItem, Select, Stack, Switch, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import type { EngineKind, FrameGenEngine, FrameGenFps, JobRequest, JobStatus, MotionKind, ToolsReport } from "../../../src/server/api-types";
import { FRAME_GEN_ENGINES, FRAME_GEN_FPS_CHOICES } from "../../../src/server/api-types";
import { api } from "../api";
import { useJobRunner } from "../hooks/useJobRunner";
import { useSettings } from "../hooks/useSettings";
import { EncodeSettingsEditor } from "./EncodeSettingsEditor";
import { JobCard } from "./JobCard";
import { EngineSelect, MotionSelect, PathFields } from "./JobFormFields";
import { NrSettingsEditor } from "./NrSettingsEditor";
import { ScaleSettingsEditor } from "./ScaleSettingsEditor";
import { Mono, Section } from "./Section";
import { VersionSelect } from "./VersionSelect";

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
        Could not check for ffmpeg ({toolsError}); its availability is unknown.
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
  const [frameGenOn, setFrameGenOn] = useState(false);
  const [targetFps, setTargetFps] = useState<FrameGenFps>("60");
  const [fgEngine, setFgEngine] = useState<FrameGenEngine>("auto");
  const [dllDir, setDllDir] = useState("");

  const canRun = input.trim() !== "" && !runner.submitting;
  const usesDlss = !frameGenOn && (engine === "sr" || engine === "nr");

  const changeEngine = (next: EngineKind): void => {
    setEngine(next);
    setDllDir(""); // a version chosen for one feature does not apply to another
  };

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
    if (frameGenOn) request.frameGen = { targetFps, engine: fgEngine };
    if (usesDlss && dllDir !== "") request.dllDir = dllDir;
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

      <Section title="Frame generation">
        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <FormControlLabel
            control={<Switch checked={frameGenOn} onChange={(_e, checked) => setFrameGenOn(checked)} />}
            label="Interpolate to a higher frame rate"
          />
          <FormControl sx={{ minWidth: 180 }} disabled={!frameGenOn}>
            <InputLabel id="fg-fps-label">Output frame rate</InputLabel>
            <Select<FrameGenFps>
              labelId="fg-fps-label"
              label="Output frame rate"
              value={targetFps}
              onChange={(event) => setTargetFps(event.target.value as FrameGenFps)}
            >
              {FRAME_GEN_FPS_CHOICES.map((fps) => (
                <MenuItem key={fps} value={fps}>
                  {fps} fps
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl sx={{ minWidth: 300 }} disabled={!frameGenOn}>
            <InputLabel id="fg-engine-label">Path</InputLabel>
            <Select<FrameGenEngine>
              labelId="fg-engine-label"
              label="Path"
              value={fgEngine}
              onChange={(event) => setFgEngine(event.target.value as FrameGenEngine)}
            >
              {FRAME_GEN_ENGINES.map((mode) => (
                <MenuItem key={mode} value={mode}>
                  {mode === "auto" ? "Auto (native when possible, else cascade)" : mode === "native" ? "Native multi-frame DLSSG" : "Cascade of 2× stages"}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        <FormHelperText sx={{ mt: 1 }}>
          DLSS Frame Generation to the chosen output rate; the result keeps the source duration and audio. Auto runs one
          native DLSSG session when output ÷ source is an exact integer the runtime supports and hardware-accelerated GPU
          scheduling (HAGS) is on; otherwise it chains 2× stages in memory (1 stage for 2×, 2 for 4×, else 3 on an 8× grid)
          and places the nearest frame on each output instant. The bundled dlssg-worker synthesises one frame per interval
          (2×), so higher rates run as a cascade; when a native multi-frame session is refused, Auto falls back to the
          cascade by itself. Uses the codec/quality below; the engine and output-size settings do not apply.
        </FormHelperText>
      </Section>

      <Section
        title="Engine, motion and output size"
        action={
          frameGenOn ? (
            <Typography variant="caption" color="warning.main">
              Ignored while frame generation is on
            </Typography>
          ) : undefined
        }
      >
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
          <EngineSelect value={engine} disabled={frameGenOn} onChange={changeEngine} />
          <MotionSelect value={motion} disabled={frameGenOn} onChange={setMotion} />
          {usesDlss ? <VersionSelect featureId={engine === "sr" ? 1 : 18} value={dllDir} onChange={setDllDir} /> : null}
          <ScaleSettingsEditor value={settings.scale} onChange={setScale} />
        </Stack>
      </Section>

      <Section title="Encoding">
        <EncodeSettingsEditor value={settings.encode} onChange={setEncode} />
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
