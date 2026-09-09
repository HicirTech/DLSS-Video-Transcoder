import { Box, Chip, Paper, Stack, Typography } from "@mui/material";
import type { ProbeReport } from "../../../../src/server/api-types";
import { KeyValueList, Mono } from "../Section";
import { BoolChip } from "../StatusChips";

interface DriverCardProps {
  driver: ProbeReport["driver"];
  device: ProbeReport["device"];
  ngxInit: ProbeReport["ngxInit"];
  capabilities: ProbeReport["capabilities"];
}

function capabilityText(value: number | string | null): string {
  if (value === null) return "null";
  return typeof value === "number" ? String(value) : value;
}

/** Driver version, NGX core location and exports, D3D12 device, NGX init result and capability parameters. */
export function DriverCard({ driver, device, ngxInit, capabilities }: DriverCardProps) {
  const capabilityRows = Object.entries(capabilities);
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2 }}>
        <Stack spacing={1.5}>
          <KeyValueList
            rows={[
              { label: "Driver version", value: driver.version ?? <Mono dim>unknown</Mono> },
              { label: "NGX core version", value: driver.ngxCoreVersion ?? <Mono dim>unknown</Mono> },
              { label: "NGX core path", value: driver.ngxCorePath ? <Mono>{driver.ngxCorePath}</Mono> : <Mono dim>not found</Mono> },
              {
                label: "Direct3D 12 device",
                value: (
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                    <BoolChip value={device.created} trueLabel="created" falseLabel="not created" />
                    {device.featureLevel ? <Mono>{device.featureLevel}</Mono> : null}
                    {!device.created && device.hresult ? <Mono dim>HRESULT {device.hresult}</Mono> : null}
                  </Stack>
                ),
              },
              {
                label: "NGX runtime init",
                value: (
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                    {ngxInit.attempted ? (
                      <BoolChip value={ngxInit.ok} trueLabel="ok" falseLabel="failed" />
                    ) : (
                      <Chip label="not attempted" variant="outlined" />
                    )}
                    {ngxInit.result ? <Mono>{ngxInit.result}</Mono> : null}
                  </Stack>
                ),
              },
            ]}
          />
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
              NGX core exports ({driver.ngxCoreExports.length})
            </Typography>
            <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap" }}>
              {driver.ngxCoreExports.map((name) => (
                <Chip key={name} label={name} variant="outlined" sx={{ fontFamily: "Consolas, monospace", fontSize: 11 }} />
              ))}
              {driver.ngxCoreExports.length === 0 ? <Mono dim>none resolved</Mono> : null}
            </Stack>
          </Box>
        </Stack>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
            Capability parameters ({capabilityRows.length})
          </Typography>
          {capabilityRows.length > 0 ? (
            <KeyValueList
              labelWidth={280}
              rows={capabilityRows.map(([name, value]) => ({
                label: name,
                value: <Mono dim={value === null}>{capabilityText(value)}</Mono>,
              }))}
            />
          ) : (
            <Mono dim>none read</Mono>
          )}
        </Box>
      </Box>
    </Paper>
  );
}
