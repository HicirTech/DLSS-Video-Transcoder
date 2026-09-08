import { Paper, Stack } from "@mui/material";
import type { ProbeReport } from "../../../../src/server/api-types";
import { KeyValueList, Mono } from "../Section";
import { BoolChip, SupportChip } from "../StatusChips";

export function ForwarderSection({ forwarder }: { forwarder: ProbeReport["forwarder"] }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <KeyValueList
        rows={[
          { label: "Forwarder DLL", value: forwarder.path ? <Mono>{forwarder.path}</Mono> : <Mono dim>not available</Mono> },
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
