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
import { OutU32, OutU64 } from "./memory.ts";

const SYMBOLS = {
  cuInit: { args: [FFIType.u32], returns: FFIType.i32 },
  cuDeviceGetCount: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuDeviceGet: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  // CUdevice_luid is 8 bytes, matching DXGI's LUID; the node mask is ignored here.
  cuDeviceGetLuid: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  cuDevicePrimaryCtxRetain: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  cuDevicePrimaryCtxRelease_v2: { args: [FFIType.i32], returns: FFIType.i32 },
  cuCtxPushCurrent_v2: { args: [FFIType.u64], returns: FFIType.i32 },
  cuCtxPopCurrent_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuCtxSynchronize: { args: [], returns: FFIType.i32 },
  cuMemcpyHtoD_v2: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  cuMemcpyDtoH_v2: { args: [FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  cuMemcpy2D_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuMemAlloc_v2: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  cuMemFree_v2: { args: [FFIType.u64], returns: FFIType.i32 },
} as const;

const CU_NAMES: Record<number, string> = {
  0: "SUCCESS", 1: "INVALID_VALUE", 2: "OUT_OF_MEMORY", 3: "NOT_INITIALIZED", 100: "NO_DEVICE",
  101: "INVALID_DEVICE", 201: "INVALID_CONTEXT", 209: "NO_BINARY_FOR_GPU", 304: "OPERATING_SYSTEM", 999: "UNKNOWN",
};
function ck(r: number, what: string): void {
  if (r !== 0) throw new Error(`CUDA ${what} failed: ${CU_NAMES[r] ?? "error"} (${r})`);
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
    ck(loaded.symbols.cuInit(0) as number, "cuInit");
    lib = loaded;
  }
  return lib.symbols;
}

function device(ordinal: number): number {
  const dev = new OutU32();
  ck(cu().cuDeviceGet(dev.ptr, ordinal) as number, "cuDeviceGet");
  return dev.value | 0;
}

/** Retain GPU `ordinal`'s primary context and push it onto *this* thread's context stack; returns the CUcontext. */
export function cudaCreateContext(ordinal: number): bigint {
  const dev = device(ordinal);
  const ctx = new OutU64();
  ck(cu().cuDevicePrimaryCtxRetain(ctx.ptr, dev) as number, "cuDevicePrimaryCtxRetain");
  ck(cu().cuCtxPushCurrent_v2(ctx.value) as number, "cuCtxPushCurrent");
  return ctx.value;
}

/**
 * Undo cudaCreateContext on this thread: pop the context and drop the retain.
 * Job workers skip this because they are terminated whole; a long-lived thread
 * (the server's, running the probe) must call it or its context stack grows by
 * one entry per probe.
 */
export function cudaReleaseContext(ordinal: number): void {
  const popped = new OutU64();
  ck(cu().cuCtxPopCurrent_v2(popped.ptr) as number, "cuCtxPopCurrent");
  ck(cu().cuDevicePrimaryCtxRelease_v2(device(ordinal)) as number, "cuDevicePrimaryCtxRelease");
}

/** What the CUDA driver says about a set of DXGI adapters, resolved in one pass. */
export interface CudaDeviceMap {
  /** Per input LUID, the CUDA ordinal whose LUID matches, or null when none does (or CUDA is unusable). */
  ordinals: (number | null)[];
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
  let count: number;
  try {
    const out = new OutU32();
    ck(cu().cuDeviceGetCount(out.ptr) as number, "cuDeviceGetCount");
    count = out.value;
  } catch (error) {
    return { ordinals, deviceCount: null, error: (error as Error).message };
  }
  const luid = new Uint8Array(8);
  const view = new DataView(luid.buffer);
  const nodeMask = new Uint32Array(1);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    luid.fill(0);
    // Not every driver/device pair supports the query; a failure just means this
    // device cannot be matched, not that the whole lookup failed.
    if ((cu().cuDeviceGetLuid(ptr(luid), ptr(nodeMask), device(ordinal)) as number) !== 0) continue;
    const low = view.getUint32(0, true);
    const high = view.getInt32(4, true);
    luids.forEach((wanted, i) => {
      if (ordinals[i] === null && (wanted.luidLow >>> 0) === low && wanted.luidHigh === high) ordinals[i] = ordinal;
    });
  }
  return { ordinals, deviceCount: count, error: null };
}

export function cudaSynchronize(): void {
  ck(cu().cuCtxSynchronize() as number, "cuCtxSynchronize");
}

/** Allocate `bytes` of device memory; returns the CUdeviceptr. */
export function cudaMalloc(bytes: number): bigint {
  const out = new OutU64();
  ck(cu().cuMemAlloc_v2(out.ptr, BigInt(bytes)) as number, "cuMemAlloc");
  return out.value;
}

export function cudaFree(device: bigint): void {
  ck(cu().cuMemFree_v2(device) as number, "cuMemFree");
}

/** Copy `bytes` from a host buffer into a device pointer (tightly packed). */
export function cudaMemcpyHtoD(dst: bigint, src: Uint8Array, bytes: number): void {
  ck(cu().cuMemcpyHtoD_v2(dst, ptr(src), BigInt(bytes)) as number, "cuMemcpyHtoD");
}

/** Copy `bytes` from a device pointer into a host buffer (tightly packed). */
export function cudaMemcpyDtoH(dst: Uint8Array, src: bigint, bytes: number): void {
  ck(cu().cuMemcpyDtoH_v2(ptr(dst), src, BigInt(bytes)) as number, "cuMemcpyDtoH");
}

/** 2D host→device copy honouring the device pitch — NVOFA buffers are pitch-linear, not tightly packed. */
export function cudaMemcpy2DHtoD(opts: {
  src: Uint8Array;
  srcPitch: number;
  dstDevice: bigint;
  dstPitch: number;
  widthBytes: number;
  height: number;
}): void {
  const desc = new Uint8Array(128);
  const dv = new DataView(desc.buffer);
  // CUDA_MEMCPY2D v2 (cuda.h, x64, 128 bytes):
  //   src XInBytes@0, Y@8, memoryType@16, host@24, device@32, array@40, pitch@48
  dv.setBigUint64(16, BigInt(CU_MEMORYTYPE_HOST), true);
  dv.setBigUint64(24, BigInt(ptr(opts.src)), true);
  dv.setBigUint64(48, BigInt(opts.srcPitch), true);
  //   dst XInBytes@56, Y@64, memoryType@72, host@80, device@88, array@96, pitch@104;
  //   WidthInBytes@112, Height@120
  dv.setBigUint64(72, BigInt(CU_MEMORYTYPE_DEVICE), true);
  dv.setBigUint64(88, opts.dstDevice, true);
  dv.setBigUint64(104, BigInt(opts.dstPitch), true);
  dv.setBigUint64(112, BigInt(opts.widthBytes), true);
  dv.setBigUint64(120, BigInt(opts.height), true);
  ck(cu().cuMemcpy2D_v2(ptr(desc)) as number, "cuMemcpy2D");
}

/** 2D device→host copy respecting the device pitch. */
export function cudaMemcpy2DDtoH(opts: {
  dst: Uint8Array;
  dstPitch: number;
  srcDevice: bigint;
  srcPitch: number;
  widthBytes: number;
  height: number;
}): void {
  const desc = new Uint8Array(128);
  const dv = new DataView(desc.buffer);
  dv.setBigUint64(16, BigInt(CU_MEMORYTYPE_DEVICE), true);
  dv.setBigUint64(32, opts.srcDevice, true);
  dv.setBigUint64(48, BigInt(opts.srcPitch), true);
  dv.setBigUint64(72, BigInt(CU_MEMORYTYPE_HOST), true);
  dv.setBigUint64(80, BigInt(ptr(opts.dst)), true);
  dv.setBigUint64(104, BigInt(opts.dstPitch), true);
  dv.setBigUint64(112, BigInt(opts.widthBytes), true);
  dv.setBigUint64(120, BigInt(opts.height), true);
  ck(cu().cuMemcpy2D_v2(ptr(desc)) as number, "cuMemcpy2D");
}
