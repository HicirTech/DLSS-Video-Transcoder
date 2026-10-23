/** Two-column label / value grid for report details. */
import { Box, Typography } from "@mui/material";
import type { ReactNode } from "react";

interface KeyValueListProps {
  rows: Array<{ label: string; value: ReactNode }>;
  /** Width of the label column in px. */
  labelWidth?: number;
}

/** A description list laid out as a grid, so assistive technology reads each label with its value. */
export function KeyValueList({ rows, labelWidth = 150 }: KeyValueListProps) {
  return (
    <Box
      component="dl"
      sx={{
        display: "grid",
        gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)`,
        columnGap: 2,
        rowGap: 0.5,
        alignItems: "center",
        fontSize: 13,
        m: 0,
      }}
    >
      {rows.map((row) => (
        <Box key={row.label} sx={{ display: "contents" }}>
          <Typography variant="body2" color="text.secondary" component="dt">
            {row.label}
          </Typography>
          <Box component="dd" sx={{ minWidth: 0, overflowWrap: "anywhere", m: 0 }}>
            {row.value}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
