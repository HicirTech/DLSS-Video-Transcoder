/** NGX feature ids, from the public nvsdk_ngx_defs.h in NVIDIA's DLSS SDK; no imports, so the web can read them too. */

export const NgxFeature = {
  SuperSampling: 1,
  InPainting: 2,
  ImageSuperResolution: 3,
  SlowMotion: 4,
  VideoSuperResolution: 5,
  ImageSignalProcessing: 9,
  DeepResolve: 10,
  FrameGeneration: 11,
  DeepDVC: 12,
  RayReconstruction: 13,
  /** DLSS 5 Neural Rendering. Reserved18 in the public header. */
  NeuralRendering: 18,
} as const;
