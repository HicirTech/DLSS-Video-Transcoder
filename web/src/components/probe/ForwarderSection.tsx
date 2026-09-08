import { Paper, Stack, Typography } from "@mui/material";
import type { ProbeReport } from "../../../../src/server/api-types";
import { KeyValueList, Mono } from "../Section";
import { BoolChip, SupportChip } from "../StatusChips";

export function ForwarderSection({ forwarder }: { forwarder: ProbeReport["forwarder"] }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        A small generated DLL that lets the app reach NVIDIA&apos;s NGX runtime. This self-test confirms it can be built
        and loaded on this machine.
      </Typography>
      <KeyValueList
        rows={[
          { label: "NGX bridge DLL", value: forwarder.path ? <Mono>{forwarder.path}</Mono> : <Mono dim>not available</Mono> },
          {
            label: "State",
            value: (
              <Stack direction="row" spacing={1}>
                <BoolChip value={forwarder.generated} trueLabel="generated" falseLabel="not generated" falseColor="warning" />
                <BoolChip value={forwarder.loaded} trueLabel="loaded" falseLabel="not loaded" />
              </Stack>
            ),
          },
          {
            label: "Self-test",
            value: forwarder.selfTest ? <SupportChip support={forwarder.selfTest} /> : <Mono dim>not run</Mono>,
          },
        ]}
      />
    </Paper>
  );
}
