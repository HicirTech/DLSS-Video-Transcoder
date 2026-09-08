import { useState } from "react";
import { Box, Button, Collapse } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { LogPanel } from "../LogPanel";

export function RawLog({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Button
        variant="text"
        onClick={() => setOpen((value) => !value)}
        endIcon={<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms" }} />}
      >
        {open ? "Hide" : "Show"} raw log ({lines.length} lines)
      </Button>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1 }}>
          <LogPanel lines={lines} maxHeight={360} emptyText="(the probe produced no log output)" />
        </Box>
      </Collapse>
    </Box>
  );
}
