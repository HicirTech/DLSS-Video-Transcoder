import { Chip, Paper, Typography } from "@mui/material";
import { AUTO_GPU_CHOICE, FRAME_GEN_GPU_CHOICE, opticalFlowGridFits, type ProbeCuda, type ProbeOpticalFlow } from "../../../../src/server/api-types";
import { KeyValueList } from "../KeyValueList";
import { Mono } from "../Mono";

interface OpticalFlowCardProps {
  cuda: ProbeCuda;
  opticalFlow: ProbeOpticalFlow;
}

function statusChip(flow: ProbeOpticalFlow) {
  if (flow.status === "ok") return <Chip label="available" color="success" />;
  if (flow.status === "unavailable") return <Chip label="unavailable" color="error" />;
  return <Chip label="not queried" variant="outlined" />;
}

/** CUDA device count and the hardware optical-flow engine (NVOFA) on the automatically chosen adapter's CUDA device. */
export function OpticalFlowCard({ cuda, opticalFlow }: OpticalFlowCardProps) {
  const limits = opticalFlow.limits;
  const grid = opticalFlow.pipelineGrid;
  // The engine never sees a source frame, only the pipeline's downscaled grid,
  // so the useful statement is whether that grid fits, not the raw numbers alone.
  const fits = limits !== null && opticalFlowGridFits(limits, grid);
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        Queried on {AUTO_GPU_CHOICE}, the automatic choice. Super Resolution and Neural Rendering jobs, with their
        in-process NVENC encode and the hardware optical-flow engine (motion = flow), run on that GPU unless Settings names
        another; for frame generation, {FRAME_GEN_GPU_CHOICE}. Without the engine, video jobs with motion = flow use the
        CPU matcher instead.
      </Typography>
      <KeyValueList
        labelWidth={200}
        rows={[
          {
            label: "CUDA devices",
            value: cuda.error === null ? <Mono>{cuda.deviceCount}</Mono> : <Mono dim>not available: {cuda.error}</Mono>,
          },
          {
            label: "Queried on",
            value: opticalFlow.cudaOrdinal === null ? <Mono dim>{opticalFlow.detail}</Mono> : <Mono>CUDA device {opticalFlow.cudaOrdinal}</Mono>,
          },
          { label: "Hardware optical flow", value: statusChip(opticalFlow) },
          ...(opticalFlow.status === "unavailable" ? [{ label: "Reason", value: <Mono>{opticalFlow.detail}</Mono> }] : []),
          {
            label: "Input size the engine accepts",
            value: limits ? (
              <Mono>
                {limits.widthMin}..{limits.widthMax} x {limits.heightMin}..{limits.heightMax} px
              </Mono>
            ) : (
              <Mono dim>unknown</Mono>
            ),
          },
          {
            label: "Output grid sizes the engine offers",
            value: opticalFlow.outGridSizes ? <Mono>{opticalFlow.outGridSizes.join(", ")} px per flow vector</Mono> : <Mono dim>unknown</Mono>,
          },
          {
            label: "Grid the pipeline feeds it",
            value: (
              <Mono>
                {grid.minSide}..{grid.maxLongSide} px a side{limits ? (fits ? ", which fits" : ", which does NOT fit") : ""}
              </Mono>
            ),
          },
        ]}
      />
    </Paper>
  );
}
