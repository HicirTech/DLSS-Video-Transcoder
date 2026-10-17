import { Box, Typography, type SxProps, type Theme } from "@mui/material";
import type { ReactNode } from "react";

interface SectionProps {
  title: string;
  /** Optional element rendered at the right end of the heading row. */
  action?: ReactNode;
  children: ReactNode;
  sx?: SxProps<Theme>;
}

/** Small upper-case heading followed by its content; used to structure every tab. */
export function Section({ title, action, children, sx }: SectionProps) {
  return (
    <Box sx={sx}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography
          variant="subtitle2"
          sx={{ color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.6, fontSize: 11 }}
        >
          {title}
        </Typography>
        {action}
      </Box>
      {children}
    </Box>
  );
}

interface KeyValueListProps {
  rows: Array<{ label: string; value: ReactNode }>;
  /** Width of the label column in px. */
  labelWidth?: number;
}

/** Two-column label / value grid for report details. */
export function KeyValueList({ rows, labelWidth = 150 }: KeyValueListProps) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)`,
        columnGap: 2,
        rowGap: 0.5,
        alignItems: "center",
        fontSize: 13,
      }}
    >
      {rows.map((row) => (
        <Box key={row.label} sx={{ display: "contents" }}>
          <Typography variant="body2" color="text.secondary" component="span">
            {row.label}
          </Typography>
          <Box component="span" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {row.value}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** Monospace inline text for paths, versions and identifiers. `pre` keeps newlines, which the default white-space collapses. */
export function Mono({ children, dim, pre }: { children: ReactNode; dim?: boolean; pre?: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        fontFamily: "Consolas, 'Cascadia Mono', monospace",
        fontSize: 12,
        color: dim ? "text.disabled" : "inherit",
        ...(pre ? { whiteSpace: "pre" } : null),
      }}
    >
      {children}
    </Box>
  );
}
