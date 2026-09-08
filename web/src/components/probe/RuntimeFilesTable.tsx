import { Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from "@mui/material";
import type { RuntimeFile } from "../../../../src/server/api-types";
import { formatMB } from "../../format";
import { Mono } from "../Section";
import { PresenceChip } from "../StatusChips";

interface RuntimeFilesTableProps {
  folder: string;
  files: RuntimeFile[];
}

export function RuntimeFilesTable({ folder, files }: RuntimeFilesTableProps) {
  return (
    <>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        Folder: <Mono>{folder}</Mono>
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>File</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Version</TableCell>
              <TableCell align="right">Size</TableCell>
              <TableCell>Exports</TableCell>
              <TableCell>Path</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {files.map((file) => (
              <TableRow key={file.name}>
                <TableCell>
                  <Mono>{file.name}</Mono>
                </TableCell>
                <TableCell>{file.role}</TableCell>
                <TableCell>
                  <PresenceChip present={file.present} />
                </TableCell>
                <TableCell>{file.version ?? "-"}</TableCell>
                <TableCell align="right">{formatMB(file.sizeMB)}</TableCell>
                <TableCell>
                  {file.exports && file.exports.length > 0 ? (
                    <Tooltip title={<Mono>{file.exports.join("\n")}</Mono>} placement="left">
                      <span style={{ cursor: "help", textDecoration: "underline dotted" }}>{file.exports.length}</span>
                    </Tooltip>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell sx={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.path ? (
                    <Tooltip title={file.path}>
                      <span>
                        <Mono dim>{file.path}</Mono>
                      </span>
                    </Tooltip>
                  ) : (
                    "-"
                  )}
                </TableCell>
              </TableRow>
            ))}
            {files.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>No runtime files were checked.</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}
