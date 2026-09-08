import { Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from "@mui/material";
import type { ProbeAdapter } from "../../../../src/server/api-types";
import { formatHex, formatMB } from "../../format";
import { Mono } from "../Section";

interface AdaptersTableProps {
  adapters: ProbeAdapter[];
  selected: number | null;
}

export function AdaptersTable({ adapters, selected }: AdaptersTableProps) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell>
            <TableCell>Adapter</TableCell>
            <TableCell>Vendor : device</TableCell>
            <TableCell align="right">Dedicated VRAM</TableCell>
            <TableCell>LUID</TableCell>
            <TableCell>Flags</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {adapters.map((adapter) => (
            <TableRow key={adapter.index} selected={adapter.index === selected}>
              <TableCell>{adapter.index}</TableCell>
              <TableCell sx={{ fontWeight: adapter.index === selected ? 600 : 400 }}>{adapter.name}</TableCell>
              <TableCell>
                <Mono>
                  {formatHex(adapter.vendorId)} : {formatHex(adapter.deviceId)}
                </Mono>
              </TableCell>
              <TableCell align="right">{formatMB(adapter.dedicatedVideoMemoryMB)}</TableCell>
              <TableCell>
                <Mono>{adapter.luid}</Mono>
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5}>
                  {adapter.index === selected ? <Chip label="selected" color="primary" /> : null}
                  {adapter.isNvidia ? <Chip label="NVIDIA" color="success" variant="outlined" /> : null}
                  {adapter.software ? <Chip label="software" color="warning" variant="outlined" /> : null}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
          {adapters.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6}>No DXGI adapters were enumerated.</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
