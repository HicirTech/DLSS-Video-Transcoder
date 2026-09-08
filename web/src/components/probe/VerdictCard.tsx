import { Alert, AlertTitle, Box } from "@mui/material";
import type { ProbeReport } from "../../../../src/server/api-types";

export function VerdictCard({ verdict }: { verdict: ProbeReport["verdict"] }) {
  const ready = verdict.neuralRenderingReady;
  return (
    <Alert severity={ready ? "success" : "error"} variant="outlined">
      <AlertTitle>{ready ? "DLSS neural rendering is ready" : "DLSS neural rendering is not ready"}</AlertTitle>
      {verdict.reasons.length > 0 ? (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {verdict.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </Box>
      ) : (
        "The probe reported no specific reasons."
      )}
    </Alert>
  );
}
