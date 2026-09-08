import { Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from "@mui/material";
import type { ProbeFeature } from "../../../../src/server/api-types";
import { formatHex } from "../../format";
import { Mono } from "../Section";
import { SupportChip } from "../StatusChips";

const NEURAL_RENDERING_FEATURE_ID = 18;

export function FeaturesTable({ features }: { features: ProbeFeature[] }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>ID</TableCell>
            <TableCell>Feature</TableCell>
            <TableCell>Support</TableCell>
            <TableCell align="right">Support code</TableCell>
            <TableCell>Min GPU architecture</TableCell>
            <TableCell>Min OS version</TableCell>
            <TableCell>Detail</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {features.map((feature) => {
            const highlight = feature.id === NEURAL_RENDERING_FEATURE_ID;
            return (
              <TableRow key={feature.id} selected={highlight}>
                <TableCell>{feature.id}</TableCell>
                <TableCell sx={{ fontWeight: highlight ? 600 : 400 }}>{feature.name}</TableCell>
                <TableCell>
                  <SupportChip support={feature.support} />
                </TableCell>
                <TableCell align="right">{feature.supportCode ?? "-"}</TableCell>
                <TableCell>{feature.minHwArchitecture !== null ? <Mono>{formatHex(feature.minHwArchitecture, 3)}</Mono> : "-"}</TableCell>
                <TableCell>{feature.minOsVersion ?? "-"}</TableCell>
                <TableCell sx={{ color: "text.secondary" }}>{feature.detail}</TableCell>
              </TableRow>
            );
          })}
          {features.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7}>The NGX runtime reported no features.</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
