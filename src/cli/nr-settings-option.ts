/** The Neural Rendering look options, read with the API's ranges and defaults by every command that takes them. */
import { DEFAULT_NR_SETTINGS, NR_PRESETS, NR_STYLES, type NrSettings, SETTING_RANGES } from "../server/api-types.ts";
import { enumOption, flag, numberOption } from "./args.ts";

/** NrSettings from the look options; warmupFrames keeps its default for the caller to set. */
export function nrSettingsOption(args: string[]): NrSettings {
  return {
    ...DEFAULT_NR_SETTINGS,
    intensity: numberOption(args, "--intensity", { ...SETTING_RANGES.intensity, fallback: DEFAULT_NR_SETTINGS.intensity }),
    style: enumOption(args, "--style", NR_STYLES, DEFAULT_NR_SETTINGS.style),
    preset: enumOption(args, "--preset", NR_PRESETS, DEFAULT_NR_SETTINGS.preset),
    localTone: numberOption(args, "--local-tone", { ...SETTING_RANGES.localTone, fallback: DEFAULT_NR_SETTINGS.localTone }),
    localStructure: numberOption(args, "--local-structure", { ...SETTING_RANGES.localStructure, fallback: DEFAULT_NR_SETTINGS.localStructure }),
    skinStructure: numberOption(args, "--skin-structure", { ...SETTING_RANGES.skinStructure, fallback: DEFAULT_NR_SETTINGS.skinStructure }),
    autoMask: flag(args, "--auto-mask") || DEFAULT_NR_SETTINGS.autoMask,
    uiCorrection: flag(args, "--ui-correction") || DEFAULT_NR_SETTINGS.uiCorrection,
  };
}
