/** The four switchable DLSS features and their NGX contract; no Node imports, so the web mock reads the same table. */
import { NgxFeature } from "./feature-ids.ts";

export type FeatureKey = "sr" | "fg" | "rr" | "nr";

export interface FeatureDescriptor {
  key: FeatureKey;
  /** NGX feature id. */
  id: number;
  name: string;
  /** Canonical filename NGX searches the feature search path for. */
  dllName: string;
  /** Sub-folder under the runtime/ dir that holds this feature's DLL(s). */
  runtimeSubdir: string;
  /** DLSS Swapper cache "kind" folder, when the cache carries this feature. */
  swapperKind: "dlss" | "dlss_d" | "dlss_g" | null;
}

/** The four switchable DLSS features; ids and filenames are the NGX contract. */
export const FEATURES: readonly FeatureDescriptor[] = [
  { key: "sr", id: NgxFeature.SuperSampling, name: "DLSS Super Resolution", dllName: "nvngx_dlss.dll", runtimeSubdir: "dlss", swapperKind: "dlss" },
  { key: "fg", id: NgxFeature.FrameGeneration, name: "DLSS Frame Generation", dllName: "nvngx_dlssg.dll", runtimeSubdir: "dlssg", swapperKind: "dlss_g" },
  { key: "rr", id: NgxFeature.RayReconstruction, name: "DLSS Ray Reconstruction", dllName: "nvngx_dlssd.dll", runtimeSubdir: "dlssd", swapperKind: "dlss_d" },
  { key: "nr", id: NgxFeature.NeuralRendering, name: "DLSS Neural Rendering", dllName: "nvngx_dlssnr.dll", runtimeSubdir: "dlssnr", swapperKind: null },
];

export function featureByKey(key: FeatureKey): FeatureDescriptor {
  return FEATURES.find((feature) => feature.key === key)!;
}
