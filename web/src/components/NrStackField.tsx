import { DEFAULT_NR_STACK, NR_PASS_GPU_MEMORY_4K_GB, SETTING_RANGES } from "../../../src/server/api-types";
import { NumberField } from "./NumberField";

interface NrStackFieldProps {
  value: number;
  onChange: (next: number) => void;
}

/** How many times Neural Rendering runs on each frame (NeuralRenderingStep.stack), on both forms' Neural Rendering card. */
export function NrStackField({ value, onChange }: NrStackFieldProps) {
  return (
    <NumberField
      label="Stack"
      value={value}
      {...SETTING_RANGES.stack}
      step={1}
      integer
      helperText={`Passes on each frame, each on the previous pass's output, for a stronger look than Intensity reaches. ${SETTING_RANGES.stack.min}–${SETTING_RANGES.stack.max}, default ${DEFAULT_NR_STACK}; each pass adds about ${NR_PASS_GPU_MEMORY_4K_GB} GB of GPU memory at 4K and its time.`}
      sx={{ width: 320 }}
      onChange={onChange}
    />
  );
}
