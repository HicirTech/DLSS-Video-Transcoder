import { useEffect, useRef } from "react";
import { styled } from "@mui/material/styles";

const LogPre = styled("pre")(({ theme }) => ({
  margin: 0,
  padding: theme.spacing(1),
  overflow: "auto",
  fontSize: 12,
  lineHeight: 1.45,
  fontFamily: "Consolas, 'Cascadia Mono', monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: theme.palette.text.secondary,
  backgroundColor: theme.palette.background.default,
  borderRadius: theme.shape.borderRadius,
  border: `1px solid ${theme.palette.divider}`,
}));

interface LogPanelProps {
  lines: string[];
  maxHeight?: number;
  emptyText?: string;
}

/** Monospace log view that keeps following new lines until the user scrolls up. */
export function LogPanel({ lines, maxHeight = 240, emptyText = "(no log lines yet)" }: LogPanelProps) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const onScroll = (): void => {
    const element = ref.current;
    if (!element) return;
    follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 12;
  };

  return (
    <LogPre ref={ref} onScroll={onScroll} style={{ maxHeight }}>
      {lines.length > 0 ? lines.join("\n") : emptyText}
    </LogPre>
  );
}
