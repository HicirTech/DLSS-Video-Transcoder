import { Box, Typography } from "@mui/material";
import type { ReactNode } from "react";

interface SectionProps {
  title: string;
  /** Optional element rendered at the right end of the heading row. */
  action?: ReactNode;
  children: ReactNode;
}

/** Small upper-case heading followed by its content. */
export function Section({ title, action, children }: SectionProps) {
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography
          variant="subtitle2"
          component="h2"
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
