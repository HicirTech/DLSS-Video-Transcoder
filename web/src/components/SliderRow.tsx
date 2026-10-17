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

/**
 * MUI centres the thumb and every mark label on its value, so at either end of the rail half of each would hang
 * past the row, over a card's border. The rail is inset by 12px: the thumb's 10px radius plus room for its
 * focus ring (8px, 14px while dragging) inside a card's own 12px of padding.
 */
const RAIL_INSET = 1.5;

/**
 * The sx that aligns a labelled mark at either end of the rail inward, so its label ends at the rail's end
 * instead of straddling it. MUI numbers the marks it draws, those within [min, max], in `data-index`.
 */
function endLabelSx(marks: SliderMark[] | undefined, min: number, max: number): Record<string, { transform: string }> {
  const drawn = (marks ?? []).filter((mark) => mark.value >= min && mark.value <= max);
  const sx: Record<string, { transform: string }> = {};
  const atMin = drawn.findIndex((mark) => mark.value === min && mark.label !== undefined);
  const atMax = drawn.findIndex((mark) => mark.value === max && mark.label !== undefined);
  if (atMin >= 0) sx[`& .MuiSlider-markLabel[data-index="${atMin}"]`] = { transform: "none" };
  if (atMax >= 0) sx[`& .MuiSlider-markLabel[data-index="${atMax}"]`] = { transform: "translateX(-100%)" };
  return sx;
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
      <Box sx={{ px: RAIL_INSET }}>
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
          sx={{ mt: -0.5, mb: hasMarkLabels ? 1.5 : 0, ...endLabelSx(marks, min, max) }}
        />
      </Box>
      {hint ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}
