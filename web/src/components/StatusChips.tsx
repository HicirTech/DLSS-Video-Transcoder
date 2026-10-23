import { Chip, type ChipProps } from "@mui/material";
import type { JobState, SupportLevel } from "../../../src/server/api-types";

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

const SUPPORT_COLORS: Record<SupportLevel, ChipColor> = {
  supported: "success",
  outdated: "warning",
  blocked: "error",
  unknown: "default",
};

/** A verdict in words, coloured by the level the server judged it at: green usable, amber fixable, red blocked. */
export function SupportChip({ label, level }: { label: string; level: SupportLevel }) {
  const color = SUPPORT_COLORS[level];
  return <Chip label={label} color={color} variant={color === "default" ? "outlined" : "filled"} />;
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
