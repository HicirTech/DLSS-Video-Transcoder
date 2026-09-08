import { Chip, type ChipProps } from "@mui/material";
import type { JobState } from "../../../src/server/api-types";

export type ChipColor = NonNullable<ChipProps["color"]>;

const STATE_COLORS: Record<JobState, ChipColor> = {
  queued: "default",
  running: "info",
  done: "success",
  failed: "error",
  cancelled: "warning",
};

export function StateChip({ state }: { state: JobState }) {
  return <Chip label={state} color={STATE_COLORS[state]} variant={state === "queued" ? "outlined" : "filled"} />;
}

/** Maps a free-form NGX support verdict to a colour: green when usable, red for hard blockers, amber otherwise. */
export function supportColor(support: string): ChipColor {
  const text = support.trim().toLowerCase();
  if (/^(supported|available|ok|ready)\b/.test(text) || text === "yes") return "success";
  if (/unsupported|not supported|not implemented|not available|missing|fail|error|denied/.test(text)) return "error";
  if (/too old|old|update|outdated|needs|unknown|partial|pending/.test(text)) return "warning";
  return "default";
}

export function SupportChip({ support }: { support: string }) {
  const color = supportColor(support);
  return <Chip label={support} color={color} variant={color === "default" ? "outlined" : "filled"} />;
}

export function PresenceChip({ present }: { present: boolean }) {
  return <Chip label={present ? "present" : "missing"} color={present ? "success" : "error"} />;
}

interface BoolChipProps {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
  /** Colour to use for `false`; defaults to error. */
  falseColor?: ChipColor;
}

export function BoolChip({ value, trueLabel = "yes", falseLabel = "no", falseColor = "error" }: BoolChipProps) {
  return <Chip label={value ? trueLabel : falseLabel} color={value ? "success" : falseColor} variant="outlined" />;
}
