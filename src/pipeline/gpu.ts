/**
 * One GPU session per job: adapter choice, D3D12 device and a synchronous
 * record/submit/wait context.
 *
 * Which adapter a job runs on is decided here, once, for the jobs and for
 * `probe`: an NVIDIA hardware adapter with a CUDA device behind its LUID. CUDA is
 * a requirement of this project, not an optimisation — in-process NVENC and the
 * hardware optical-flow engine run on it — so an adapter without one is refused
 * with the adapters that qualify, never run degraded.
 */
import { cudaDevicesForLuids, type CudaDeviceMap } from "../native/cuda.ts";
import { D3D12Device, GpuContext } from "../native/d3d12.ts";
import { type AdapterInfo, DxgiFactory, type DxgiAdapter, isHardwareNvidia, selectAdapter } from "../native/dxgi.ts";

export interface GpuOptions {
  adapterIndex?: number;
  debugLayer?: boolean;
}

export interface GpuSession {
  readonly factory: DxgiFactory;
  readonly adapters: DxgiAdapter[];
  readonly adapter: DxgiAdapter;
  readonly device: D3D12Device;
  readonly gpu: GpuContext;
  /**
   * The CUDA ordinal for THIS adapter, matched by LUID. Never the DXGI index:
   * the two enumerations are unrelated, and on a machine with mirrored or
   * virtual display adapters several DXGI entries can share a GPU name while
   * only one has a CUDA device behind it. NVENC and NVOFA must use this, or they
   * run on a different GPU than the renderer and the shared-resource paths
   * between them fail. openGpu refuses an adapter that has none.
   */
  readonly cudaOrdinal: number;
  close(): void;
}

/** A DXGI adapter as chooseGpu sees it: its description plus what CUDA said about its LUID. */
export interface GpuCandidate {
  info: AdapterInfo;
  cudaOrdinal: number | null;
}

/** The driver-level half of a CUDA lookup, shared by every candidate: how many devices, or why none could be asked for. */
export type CudaSummary = Pick<CudaDeviceMap, "deviceCount" | "error">;

export interface GpuChoice {
  /** DXGI index of the adapter to use, for a job or for diagnostics; null when no adapter can be named. */
  index: number | null;
  /** CUDA device behind it; null makes the choice ineligible for a job. */
  cudaOrdinal: number | null;
  /** Why a job on this choice is refused, one sentence a user can act on; empty means eligible. */
  reasons: string[];
}

const describe = (c: GpuCandidate): string =>
  `${c.info.index}: ${c.info.name}${c.cudaOrdinal === null ? "" : ` (LUID ${c.info.luid}, CUDA device ${c.cudaOrdinal})`}`;

/** Why CUDA reports no device for an adapter, from what the driver actually said. */
function cudaVerdict(cuda: CudaSummary, c: GpuCandidate): string {
  if (cuda.error !== null) return `CUDA could not be queried: ${cuda.error}.`;
  if (cuda.deviceCount === 0) return "CUDA lists no device.";
  return `CUDA lists ${cuda.deviceCount} device(s), none reporting this adapter's LUID ${c.info.luid}.`;
}

/**
 * The adapter a job runs on, or the one `probe` should diagnose, from the same
 * rule. Explicit index: that adapter, refused with one reason when it is not an
 * NVIDIA hardware adapter or has no CUDA device. Auto: the NVIDIA hardware
 * adapter with the most VRAM among those with a CUDA device (ties: the lowest
 * CUDA ordinal), else the best NVIDIA adapter with the reason it is refused so a
 * probe can still diagnose D3D12 and NGX on it, else nothing.
 *
 * Pure: the ordering (NVIDIA, hardware, most VRAM) stays selectAdapter's, and
 * the LUID matching stays cudaDevicesForLuids's; this only adds the requirement.
 */
export function chooseGpu(candidates: readonly GpuCandidate[], cuda: CudaSummary, preferredIndex?: number): GpuChoice {
  const withCuda = candidates.filter((c) => isHardwareNvidia(c.info) && c.cudaOrdinal !== null);
  const usable = withCuda.map(describe).join(", ");
  if (preferredIndex !== undefined) {
    const chosen = candidates.find((c) => c.info.index === preferredIndex);
    if (!chosen) {
      const listed = candidates.map(describe).join(", ") || "none";
      return { index: null, cudaOrdinal: null, reasons: [`No adapter at index ${preferredIndex}. Available adapters: ${listed}.`] };
    }
    const alternatives = usable ? `Adapters with a CUDA device: ${usable}.` : "No listed NVIDIA adapter has a CUDA device.";
    if (!isHardwareNvidia(chosen.info)) {
      return { index: chosen.info.index, cudaOrdinal: null, reasons: [`Adapter ${chosen.info.index} (${chosen.info.name}) is not an NVIDIA GPU, and DLSS runs only on NVIDIA. ${alternatives}`] };
    }
    if (chosen.cudaOrdinal === null) {
      // DXGI indices are per run: the same GPU can be listed under another
      // number next time, so the alternatives carry the LUID CUDA matched on.
      return {
        index: chosen.info.index,
        cudaOrdinal: null,
        reasons: [`Adapter ${chosen.info.index} (${chosen.info.name}, LUID ${chosen.info.luid}) has no CUDA device behind it, and this tool's jobs run NVENC and hardware optical flow on CUDA. ${cudaVerdict(cuda, chosen)} ${alternatives} DXGI indices can change between runs; match by LUID.`],
      };
    }
    return { index: chosen.info.index, cudaOrdinal: chosen.cudaOrdinal, reasons: [] };
  }
  // selectAdapter's sort is stable, so ordering by CUDA ordinal first turns a
  // VRAM tie into "lowest ordinal" instead of "whatever DXGI listed first".
  const best = selectAdapter([...withCuda].sort((a, b) => a.cudaOrdinal! - b.cudaOrdinal!));
  if (best) return { index: best.info.index, cudaOrdinal: best.cudaOrdinal, reasons: [] };
  const fallback = selectAdapter(candidates);
  if (fallback) {
    return {
      index: fallback.info.index,
      cudaOrdinal: null,
      reasons: [`${fallback.info.name} (adapter ${fallback.info.index}, LUID ${fallback.info.luid}) has no CUDA device behind it, and this tool's jobs run NVENC and hardware optical flow on CUDA. ${cudaVerdict(cuda, fallback)} No listed NVIDIA adapter has one.`],
    };
  }
  const listed = candidates.map(describe).join(", ") || "none";
  return { index: null, cudaOrdinal: null, reasons: [`No NVIDIA GPU was found; DLSS requires an NVIDIA RTX GPU. Available adapters: ${listed}.`] };
}

/** The adapter list as chooseGpu wants it, with one CUDA lookup for all of them. */
export function gpuCandidates(adapters: readonly DxgiAdapter[]): { candidates: GpuCandidate[]; cuda: CudaDeviceMap } {
  const cuda = cudaDevicesForLuids(adapters.map((a) => a.info));
  return { candidates: adapters.map((a, i) => ({ info: a.info, cudaOrdinal: cuda.ordinals[i]! })), cuda };
}

/** One line naming the GPU a job runs on, for progress output: adapter, LUID and the CUDA device it resolved to. */
export function describeGpu(session: GpuSession): string {
  return `GPU: adapter ${session.adapter.info.index} ${session.adapter.info.name}, LUID ${session.adapter.info.luid}, CUDA device ${session.cudaOrdinal}`;
}

export function openGpu(options: GpuOptions = {}): GpuSession {
  const factory = DxgiFactory.create();
  const adapters = factory.enumerate();
  // Resolved once here rather than at every CUDA call: cuInit plus a LUID read
  // per device, and the answer cannot change while the session is open.
  const { candidates, cuda } = gpuCandidates(adapters);
  const choice = chooseGpu(candidates, cuda, options.adapterIndex);
  const adapter = choice.index === null ? null : adapters.find((a) => a.info.index === choice.index);
  if (!adapter || choice.cudaOrdinal === null) {
    for (const a of adapters) a.release();
    factory.release();
    throw new Error(choice.reasons.join(" "));
  }
  const cudaOrdinal = choice.cudaOrdinal;
  let device: D3D12Device | null = null;
  let gpu: GpuContext;
  try {
    device = D3D12Device.create(adapter, { debugLayer: options.debugLayer });
    gpu = new GpuContext(device);
  } catch (error) {
    device?.release();
    for (const a of adapters) a.release();
    factory.release();
    throw error;
  }
  let closed = false;
  return {
    factory,
    adapters,
    adapter,
    device,
    gpu,
    cudaOrdinal,
    close() {
      if (closed) return;
      closed = true;
      gpu.close();
      device.release();
      for (const a of adapters) a.release();
      factory.release();
    },
  };
}
