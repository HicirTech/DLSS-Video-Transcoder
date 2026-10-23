/**
 * Minimal CUDA Driver API (nvcuda.dll) bindings: context creation and host<->device
 * copies, enough to feed the hardware Optical Flow engine in src/pipeline/nvof.ts
 * alongside our D3D12 device.
 *
 * CUresult 0 = CUDA_SUCCESS. 64-bit handles (CUcontext, CUdeviceptr) are carried
 * as bigint; CUdevice is a 32-bit ordinal.
 *
 * The DLL is loaded on first use, not at import: the probe reports a missing or
 * broken CUDA driver as a report field, which it could not do if importing this
 * module already required the DLL to be present.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { formatDeviceUuid } from "./device-uuid.ts";
import { NativeStruct, OutU32, OutU64 } from "./memory.ts";

const SYMBOLS = {
  cuInit: { args: [FFIType.u32], returns: FFIType.i32 },
  cuDeviceGetCount: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuDeviceGet: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  // CUdevice_luid is 8 bytes, matching DXGI's LUID; the node mask is ignored here.
  cuDeviceGetLuid: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  // CUuuid is 16 bytes; the same identity nvidia-smi prints as GPU-xxxxxxxx-...
  cuDeviceGetUuid_v2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  cuDevicePrimaryCtxRetain: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  cuDevicePrimaryCtxRelease_v2: { args: [FFIType.i32], returns: FFIType.i32 },
  cuCtxPushCurrent_v2: { args: [FFIType.u64], returns: FFIType.i32 },
  cuCtxPopCurrent_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuCtxSynchronize: { args: [], returns: FFIType.i32 },
  cuMemcpyHtoD_v2: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  cuMemcpy2D_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuMemAlloc_v2: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  cuMemFree_v2: { args: [FFIType.u64], returns: FFIType.i32 },
} as const;

const CU_NAMES: Record<number, string> = {
  0: "SUCCESS", 1: "INVALID_VALUE", 2: "OUT_OF_MEMORY", 3: "NOT_INITIALIZED", 100: "NO_DEVICE",
  101: "INVALID_DEVICE", 201: "INVALID_CONTEXT", 209: "NO_BINARY_FOR_GPU", 304: "OPERATING_SYSTEM", 999: "UNKNOWN",
};

/** Throws when a CUDA Driver API call returned anything but CUDA_SUCCESS, naming the result where it is known. */
export function checkCuResult(result: number, what: string): void {
  if (result !== 0) throw new Error(`CUDA ${what} failed: ${CU_NAMES[result] ?? "error"} (${result})`);
}

const CU_MEMORYTYPE_HOST = 1;
const CU_MEMORYTYPE_DEVICE = 2;

function load() {
  return dlopen("nvcuda.dll", SYMBOLS);
}

let lib: ReturnType<typeof load> | null = null;

/** The driver's symbols, loaded and cuInit'ed once; throws the dlopen or cuInit error when CUDA is unusable. */
function cu(): ReturnType<typeof load>["symbols"] {
  if (!lib) {
    const loaded = load();
    checkCuResult(loaded.symbols.cuInit(0) as number, "cuInit");
    lib = loaded;
  }
  return lib.symbols;
}

function device(ordinal: number): number {
  const dev = new OutU32();
  checkCuResult(cu().cuDeviceGet(dev.bytes, ordinal) as number, "cuDeviceGet");
  return dev.value | 0;
}

/** Retain GPU `ordinal`'s primary context and push it onto *this* thread's context stack; returns the CUcontext. */
export function cudaCreateContext(ordinal: number): bigint {
  const dev = device(ordinal);
  const ctx = new OutU64();
  checkCuResult(cu().cuDevicePrimaryCtxRetain(ctx.bytes, dev) as number, "cuDevicePrimaryCtxRetain");
  const pushed = cu().cuCtxPushCurrent_v2(ctx.value) as number;
  if (pushed !== 0) {
    // The caller gets no context to release, so the retain is handed back here; the push error is the one reported.
    cu().cuDevicePrimaryCtxRelease_v2(dev);
    checkCuResult(pushed, "cuCtxPushCurrent");
  }
  return ctx.value;
}

/**
 * Undo cudaCreateContext on this thread: pop the context and drop the retain, the retain even when the pop fails.
 * Job workers skip this because they are terminated whole; probeNvof calls it so a probe leaves its thread's context
 * stack as it found it, which keeps repeated probes in one process from growing that stack by one entry each.
 */
export function cudaReleaseContext(ordinal: number): void {
  const popped = new OutU64();
  try {
    checkCuResult(cu().cuCtxPopCurrent_v2(popped.bytes) as number, "cuCtxPopCurrent");
  } finally {
    checkCuResult(cu().cuDevicePrimaryCtxRelease_v2(device(ordinal)) as number, "cuDevicePrimaryCtxRelease");
  }
}

/** What the CUDA driver says about a set of DXGI adapters, resolved in one pass. */
export interface CudaDeviceMap {
  /** Per input LUID, the CUDA ordinal whose LUID matches, or null when none does (or CUDA is unusable). */
  ordinals: (number | null)[];
  /**
   * Per input LUID, the matched device's UUID in nvidia-smi's form
   * ("GPU-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2"), or null alongside a null
   * ordinal. Unlike a LUID, which Windows reissues at every boot, or a DXGI
   * index, which changes between runs, the UUID names the same GPU forever, so
   * it is what a stored adapter choice is keyed by.
   */
  uuids: (string | null)[];
  /** How many devices the driver lists; null when it could not be asked. */
  deviceCount: number | null;
  /** Why CUDA could not be asked (nvcuda.dll missing, cuInit failed); null when it answered. */
  error: string | null;
}

/**
 * The CUDA ordinal behind each adapter LUID. One cuInit, one walk over the
 * devices, never throws: a broken or absent CUDA driver comes back as `error`
 * with every ordinal null, so a caller can report the cause instead of guessing.
 *
 * DXGI and CUDA enumerate independently: on this machine DXGI lists three
 * entries named "RTX 5090" with different LUIDs while CUDA reports one device,
 * so taking ordinal 0 for whichever adapter D3D12 chose is a guess that holds
 * only while exactly one NVIDIA GPU is visible to CUDA. A mismatch would put the
 * encoder or the flow engine on a different GPU than the renderer.
 */
export function cudaDevicesForLuids(luids: readonly { luidLow: number; luidHigh: number }[]): CudaDeviceMap {
  const ordinals: (number | null)[] = luids.map(() => null);
  const uuids: (string | null)[] = luids.map(() => null);
  let count: number;
  try {
    const out = new OutU32();
    checkCuResult(cu().cuDeviceGetCount(out.bytes) as number, "cuDeviceGetCount");
    count = out.value;
  } catch (error) {
    return { ordinals, uuids, deviceCount: null, error: (error as Error).message };
  }
  const luid = new Uint8Array(8);
  const view = new DataView(luid.buffer);
  const nodeMask = new Uint32Array(1);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const dev = device(ordinal);
    luid.fill(0);
    // Not every driver/device pair supports the query; a failure just means this
    // device cannot be matched, not that the whole lookup failed.
    if ((cu().cuDeviceGetLuid(luid, nodeMask, dev) as number) !== 0) continue;
    const low = view.getUint32(0, true);
    const high = view.getInt32(4, true);
    let uuid: string | null = null;
    luids.forEach((wanted, i) => {
      if (ordinals[i] !== null || (wanted.luidLow >>> 0) !== low || wanted.luidHigh !== high) return;
      ordinals[i] = ordinal;
      uuids[i] = uuid ??= deviceUuid(dev);
    });
  }
  return { ordinals, uuids, deviceCount: count, error: null };
}

/** A device's UUID as nvidia-smi prints it, or null when the driver will not report one. */
function deviceUuid(dev: number): string | null {
  const bytes = new Uint8Array(16);
  if ((cu().cuDeviceGetUuid_v2(bytes, dev) as number) !== 0) return null;
  return formatDeviceUuid(bytes);
}

export function cudaSynchronize(): void {
  checkCuResult(cu().cuCtxSynchronize() as number, "cuCtxSynchronize");
}

/** Allocate `bytes` of device memory; returns the CUdeviceptr. */
export function cudaMalloc(bytes: number): bigint {
  const out = new OutU64();
  checkCuResult(cu().cuMemAlloc_v2(out.bytes, BigInt(bytes)) as number, "cuMemAlloc");
  return out.value;
}

export function cudaFree(devPtr: bigint): void {
  checkCuResult(cu().cuMemFree_v2(devPtr) as number, "cuMemFree");
}

/** Copy `bytes` from a host buffer into a device pointer (tightly packed). */
export function cudaMemcpyHtoD(dst: bigint, src: Uint8Array, bytes: number): void {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > src.byteLength) {
    throw new RangeError(`cudaMemcpyHtoD: ${bytes} bytes do not fit the ${src.byteLength}-byte host buffer`);
  }
  checkCuResult(cu().cuMemcpyHtoD_v2(dst, src, BigInt(bytes)) as number, "cuMemcpyHtoD");
}

/** Throws when `height` rows of `widthBytes` at `pitch` reach past the host buffer the driver would read or write. */
function checkHostSpan(host: Uint8Array, pitch: number, widthBytes: number, height: number, what: string): void {
  if (widthBytes > pitch) throw new RangeError(`${what}: a row of ${widthBytes} bytes does not fit its ${pitch}-byte pitch`);
  const needed = height > 0 ? (height - 1) * pitch + widthBytes : 0;
  if (needed > host.byteLength) throw new RangeError(`${what}: the copy needs ${needed} host bytes, the buffer has ${host.byteLength}`);
}

/** One side of a 2D copy: host memory (kept referenced by the caller until the copy returns) or a device pointer. */
type CopySide = { host: Uint8Array; pitch: number } | { device: bigint; pitch: number };

function copy2D(src: CopySide, dst: CopySide, widthBytes: number, height: number): void {
  // CUDA_MEMCPY2D v2 (cuda.h, x64, 128 bytes): src XInBytes@0, Y@8, memoryType@16, host@24, device@32, array@40,
  // pitch@48; dst = src + 56; WidthInBytes@112, Height@120.
  const desc = new NativeStruct(128);
  for (const [base, side] of [[0, src], [56, dst]] as const) {
    if ("host" in side) desc.u64(base + 16, CU_MEMORYTYPE_HOST).u64(base + 24, ptr(side.host));
    else desc.u64(base + 16, CU_MEMORYTYPE_DEVICE).u64(base + 32, side.device);
    desc.u64(base + 48, side.pitch);
  }
  desc.u64(112, widthBytes).u64(120, height);
  checkCuResult(cu().cuMemcpy2D_v2(desc.bytes) as number, "cuMemcpy2D");
}

/**
 * 2D host→device copy honouring the device pitch — NVOFA buffers are pitch-linear, not tightly packed.
 * `src` goes into the descriptor as a plain address, so the caller keeps it referenced until this returns.
 */
export function cudaMemcpy2DHtoD(opts: {
  src: Uint8Array;
  srcPitch: number;
  dstDevice: bigint;
  dstPitch: number;
  widthBytes: number;
  height: number;
}): void {
  checkHostSpan(opts.src, opts.srcPitch, opts.widthBytes, opts.height, "cudaMemcpy2DHtoD");
  copy2D({ host: opts.src, pitch: opts.srcPitch }, { device: opts.dstDevice, pitch: opts.dstPitch }, opts.widthBytes, opts.height);
}

/**
 * 2D device→host copy respecting the device pitch. Like `src` of cudaMemcpy2DHtoD, `dst` is only an
 * address in the descriptor, so the caller keeps it referenced until this returns.
 */
export function cudaMemcpy2DDtoH(opts: {
  dst: Uint8Array;
  dstPitch: number;
  srcDevice: bigint;
  srcPitch: number;
  widthBytes: number;
  height: number;
}): void {
  checkHostSpan(opts.dst, opts.dstPitch, opts.widthBytes, opts.height, "cudaMemcpy2DDtoH");
  copy2D({ device: opts.srcDevice, pitch: opts.srcPitch }, { host: opts.dst, pitch: opts.dstPitch }, opts.widthBytes, opts.height);
}
