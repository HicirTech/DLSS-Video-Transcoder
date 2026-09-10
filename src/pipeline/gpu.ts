/**
 * One GPU session per job: adapter choice, D3D12 device and a synchronous
 * record/submit/wait context.
 */
import { cudaOrdinalForLuid } from "../native/cuda.ts";
import { D3D12Device, GpuContext } from "../native/d3d12.ts";
import { DxgiFactory, selectAdapter, type DxgiAdapter } from "../native/dxgi.ts";

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
   * The CUDA ordinal for THIS adapter, matched by LUID, or null when CUDA does
   * not know it. Never the DXGI index: the two enumerations are unrelated, and
   * on a machine with mirrored or virtual display adapters several DXGI entries
   * can share a GPU name while only one has a CUDA device behind it. NVENC and
   * NVOFA must use this, or they run on a different GPU than the renderer and
   * the shared-resource paths between them fail.
   */
  readonly cudaOrdinal: number | null;
  close(): void;
}

export function openGpu(options: GpuOptions = {}): GpuSession {
  const factory = DxgiFactory.create();
  const adapters = factory.enumerate();
  const adapter = selectAdapter(adapters, options.adapterIndex);
  if (!adapter) {
    // Name what is actually present: "no NVIDIA adapter found" is misleading when
    // the caller asked for an index that simply does not exist.
    const listed = adapters.map((a) => `${a.info.index}: ${a.info.name}`).join(", ") || "none";
    const asked = options.adapterIndex;
    for (const a of adapters) a.release();
    factory.release();
    throw new Error(
      asked !== undefined
        ? `No adapter at index ${asked}. Available adapters: ${listed}. Run \`probe\` to list them.`
        : `No NVIDIA adapter found. Available adapters: ${listed}. Pass --adapter <index> to choose one explicitly.`,
    );
  }
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
  // Resolved once here rather than at every CUDA call: cuInit plus a LUID read
  // per device, and the answer cannot change while the session is open.
  let cudaOrdinal: number | null = null;
  try {
    cudaOrdinal = cudaOrdinalForLuid(adapter.info.luidLow, adapter.info.luidHigh);
  } catch {
    // No CUDA at all (no driver, or a non-NVIDIA adapter). The CUDA-backed paths
    // check for null and fall back; the D3D12 work does not need it.
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
