import { Box, Slider, Typography } from "@mui/material";

interface SliderMark {
  value: number;
  label?: string;
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  marks?: SliderMark[];
  disabled?: boolean;
  /** Text shown next to the label and in the value tooltip. */
  format?: (value: number) => string;
  hint?: string;
  onChange: (value: number) => void;
}

/** A labelled slider with the current value printed on the right. */
export function SliderRow({ label, value, min, max, step = 0.05, marks, disabled, format, hint, onChange }: SliderRowProps) {
  const text = format ? format(value) : value.toFixed(2);
  const hasMarkLabels = marks?.some((mark) => mark.label !== undefined) ?? false;
  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Typography variant="body2" color={disabled ? "text.disabled" : "text.primary"}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "Consolas, monospace" }}>
          {text}
        </Typography>
      </Box>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        marks={marks}
        disabled={disabled}
        valueLabelDisplay="auto"
        valueLabelFormat={format}
        onChange={(_event, next) => onChange(Array.isArray(next) ? (next[0] ?? value) : next)}
        sx={{ mt: -0.5, mb: hasMarkLabels ? 1.5 : 0 }}
      />
      {hint ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}
