/** Monospace inline text for paths, versions and identifiers. */
import { Box } from "@mui/material";
import type { ReactNode } from "react";
import { monoFontFamily } from "../theme";

/** `pre` keeps newlines, which the default white-space collapses. */
export function Mono({ children, dim, pre }: { children: ReactNode; dim?: boolean; pre?: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        fontFamily: monoFontFamily,
        fontSize: 12,
        color: dim ? "text.disabled" : "inherit",
        ...(pre ? { whiteSpace: "pre" } : null),
      }}
    >
      {children}
    </Box>
  );
}
