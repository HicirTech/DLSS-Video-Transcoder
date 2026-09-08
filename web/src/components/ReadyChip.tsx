import { Box, Chip, CircularProgress, Tooltip } from "@mui/material";
import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import type { ProbeReport } from "../../../src/server/api-types";

interface ReadyChipProps {
  probe: ProbeReport | null;
  probing: boolean;
  onProbe: () => void;
}

/** AppBar status: neural rendering ready / not ready per the last probe verdict; click to (re)probe. */
export function ReadyChip({ probe, probing, onProbe }: ReadyChipProps) {
  if (probing) {
    return <Chip icon={<CircularProgress size={12} color="inherit" />} label="Probing..." variant="outlined" />;
  }
  if (!probe) {
    return (
      <Tooltip title="Run the hardware / runtime probe">
        <Chip label="Not probed" variant="outlined" onClick={onProbe} />
      </Tooltip>
    );
  }
  const ready = probe.verdict.neuralRenderingReady;
  const reasons = probe.verdict.reasons;
  const title =
    reasons.length > 0 ? (
      <Box component="ul" sx={{ m: 0, pl: 2 }}>
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </Box>
    ) : ready ? (
      "Neural rendering is ready"
    ) : (
      "Neural rendering is not ready"
    );
  return (
    <Tooltip title={title}>
      <Chip
        icon={ready ? <CheckCircleIcon /> : <CancelIcon />}
        label={ready ? "Neural rendering ready" : "Neural rendering not ready"}
        color={ready ? "success" : "error"}
        onClick={onProbe}
      />
    </Tooltip>
  );
}
