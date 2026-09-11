import { Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip } from "@mui/material";
import type { ProbeAdapter, ProbeCuda } from "../../../../src/server/api-types";
import { formatHex, formatMB } from "../../format";
import { Mono } from "../Section";

interface AdaptersTableProps {
  adapters: ProbeAdapter[];
  selected: number | null;
  cuda: ProbeCuda;
}

/** The CUDA column: the device ordinal, "none" when CUDA lists no device for the LUID, "n/a" when CUDA could not be asked at all. */
function CudaCell({ adapter, cuda }: { adapter: ProbeAdapter; cuda: ProbeCuda }) {
  if (cuda.error !== null) {
    return (
      <Tooltip title={cuda.error}>
        <Mono dim>n/a</Mono>
      </Tooltip>
    );
  }
  return adapter.cudaOrdinal === null ? <Mono dim>none</Mono> : <Mono>device {adapter.cudaOrdinal}</Mono>;
}

export function AdaptersTable({ adapters, selected, cuda }: AdaptersTableProps) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>Index</TableCell>
            <TableCell>Adapter</TableCell>
            <TableCell>Vendor : device ID</TableCell>
            <TableCell align="right">Dedicated VRAM</TableCell>
            <TableCell>LUID</TableCell>
            <TableCell>CUDA</TableCell>
            <TableCell>Status</TableCell>
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
                <CudaCell adapter={adapter} cuda={cuda} />
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5}>
                  {adapter.index === selected ? <Chip label="selected" color="primary" /> : null}
                  {adapter.isNvidia ? <Chip label="NVIDIA" color="success" variant="outlined" /> : null}
                  {adapter.software ? <Chip label="software renderer" color="warning" variant="outlined" /> : null}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
          {adapters.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7}>No display adapters (GPUs) were found.</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
