/**
 * The CUDA device frame generation's helper workers, NVENC encode and NVOFA optical flow, run on.
 */

/**
 * Frame generation has no adapter selection (README, "Shared options"): these helpers use CUDA's
 * first device, while the host process (dlssg-host.ts) takes openGpu()'s automatic choice, which can
 * be another GPU on a machine with more than one NVIDIA GPU. The other pipelines resolve theirs by
 * LUID (GpuSession.cudaOrdinal).
 */
export const FRAMEGEN_CUDA_DEVICE = 0;
