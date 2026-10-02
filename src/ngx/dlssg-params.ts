/**
 * DLSS Frame Generation (NGX feature 11) parameter names that our in-process host reads and sets.
 * Re-declared from the public nvsdk_ngx_defs_dlssg.h (NVIDIA/DLSS v310.9.1). The generic names
 * (Width, Height, the node masks and the FrameGeneration.* capabilities) belong to NgxParam.
 */

/** Read from GetCapabilityParameters; nvsdk_ngx_defs_dlssg.h:350-353. */
export const DlssgCapabilityParam = {
  /** Most generated frames per source interval, so 3 means 4x. 1 or less, or unset, means 2x only. */
  MultiFrameCountMax: "DLSSG.MultiFrameCountMax",
} as const;

/** Set once before CreateFeature; nvsdk_ngx_defs_dlssg.h:60, 112-116, 313-318, 366-370. */
export const DlssgCreateParam = {
  /**
   * The header says these take precedence over the generic Width/Height, but NVIDIA's own
   * create helper (nvsdk_ngx_helpers_dlssg_d3d.h:56-57) sets only the generic pair. Setting both
   * to the colour size creates the feature on nvngx_dlssg.dll 310.7.129 and 310.9.1.
   */
  Width: "DLSSG.Width",
  Height: "DLSSG.Height",
  /** A DXGI_FORMAT value shared by Backbuffer and OutputInterpolated. */
  BackbufferFormat: "DLSSG.BackbufferFormat",
  /** Size of the MVecs and Depth textures; frame generation does not upscale, so it equals Width/Height. */
  InternalWidth: "DLSSG.InternalWidth",
  InternalHeight: "DLSSG.InternalHeight",
  DynamicResolution: "DLSSG.DynamicResolution",
  /** Create-time only; we pass no HUDLess, UI or UIAlpha to recompose from. */
  UserInterfaceRecompositionEnabled: "DLSSG.UserInterfaceRecompositionEnabled",
} as const;

/**
 * Set before every EvaluateFeature; nvsdk_ngx_defs_dlssg.h:64-93, 118-144, 185-194,
 * 355-364. Semantics from the DLSS-FG Programming Guide v310.7.0, pages 96-110; the failure
 * results quoted below were measured on nvngx_dlssg.dll 310.9.1.
 */
export const DlssgEvaluateParam = {
  /** ID3D12Resource inputs, in NON_PIXEL_SHADER_RESOURCE state. */
  Backbuffer: "DLSSG.Backbuffer",
  /** Two-channel float motion, current to previous, +x right and +y down. */
  MVecs: "DLSSG.MVecs",
  /** Hardware (non-linear) depth. Required: a null resource fails with MissingInput. */
  Depth: "DLSSG.Depth",
  /** ID3D12Resource output in UNORDERED_ACCESS state; a separate texture for each MultiFrameIndex. */
  OutputInterpolated: "DLSSG.OutputInterpolated",
  /** A UAV buffer of at least 4 bytes (nvsdk_ngx_defs_dlssg.h:118-123); classifyInterval in dlssg-interval.ts reads it. */
  OutputDisableInterpolation: "DLSSG.OutputDisableInterpolation",
  /**
   * Optional inputs and output that the host binds to null on every evaluate, as NVIDIA's
   * evaluate helper does (nvsdk_ngx_helpers_dlssg_d3d.h:73-82).
   */
  HUDLess: "DLSSG.HUDLess",
  UI: "DLSSG.UI",
  UIAlpha: "DLSSG.UIAlpha",
  BidirectionalDistortionField: "DLSSG.BidirectionalDistortionField",
  OutputReal: "DLSSG.OutputReal",
  /**
   * Pointers to float[16], row-major and post-multiplied (Programming Guide p.22). Without
   * them EvaluateFeature fails with MissingInput. The camera position, basis, near/far and FOV
   * scalars are not set: at MultiFrameCount 1, 3 and 5 on 310.9.1 adding them changed no output byte.
   */
  CameraViewToClip: "DLSSG.CameraViewToClip",
  ClipToCameraView: "DLSSG.ClipToCameraView",
  ClipToPrevClip: "DLSSG.ClipToPrevClip",
  PrevClipToClip: "DLSSG.PrevClipToClip",
  ClipToLensClip: "DLSSG.ClipToLensClip",
  /** The runtime multiplies MVecs by these and reads the result as pixels. */
  MvecScaleX: "DLSSG.MvecScaleX",
  MvecScaleY: "DLSSG.MvecScaleY",
  DepthInverted: "DLSSG.DepthInverted",
  /** Honoured only at MultiFrameIndex 1. */
  Reset: "DLSSG.Reset",
  /** Generated frames this interval, 1..MultiFrameCountMax; the same on every call of one interval. */
  MultiFrameCount: "DLSSG.MultiFrameCount",
  /** 1-based and strictly increasing; 0 or a value above MultiFrameCount fails with InvalidParameter. */
  MultiFrameIndex: "DLSSG.MultiFrameIndex",
  /** uint64, one step per source frame. */
  BackbufferFrameID: "DLSSG.BackbufferFrameID",
} as const;
