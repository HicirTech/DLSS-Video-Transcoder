/**
 * Minimal CUDA Driver API (nvcuda.dll) bindings — just enough to drive NVIDIA's
 * hardware Optical Flow engine (NVOFA, src/pipeline/nvof.ts) alongside our D3D12
 * device: create a context on the GPU and copy frames to / flow vectors from the
 * NVOFA GPU buffers.
 *
 * CUresult 0 = CUDA_SUCCESS. 64-bit handles (CUcontext, CUdeviceptr) are carried
 * as bigint; CUdevice is a 32-bit ordinal.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { OutU32, OutU64 } from "./memory.ts";

const cuda = dlopen("nvcuda.dll", {
  cuInit: { args: [FFIType.u32], returns: FFIType.i32 },
  cuDeviceGetCount: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuDeviceGet: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  cuDevicePrimaryCtxRetain: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  cuCtxPushCurrent_v2: { args: [FFIType.u64], returns: FFIType.i32 },
  cuCtxPopCurrent_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuCtxSynchronize: { args: [], returns: FFIType.i32 },
  cuMemcpyHtoD_v2: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  cuMemcpyDtoH_v2: { args: [FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  cuMemcpy2D_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
  cuMemAlloc_v2: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  cuMemFree_v2: { args: [FFIType.u64], returns: FFIType.i32 },
});

const CU_NAMES: Record<number, string> = {
  0: "SUCCESS", 1: "INVALID_VALUE", 2: "OUT_OF_MEMORY", 3: "NOT_INITIALIZED", 100: "NO_DEVICE",
  101: "INVALID_DEVICE", 201: "INVALID_CONTEXT", 209: "NO_BINARY_FOR_GPU", 304: "OPERATING_SYSTEM", 999: "UNKNOWN",
};
function ck(r: number, what: string): void {
  if (r !== 0) throw new Error(`CUDA ${what} failed: ${CU_NAMES[r] ?? "error"} (${r})`);
}

const CU_MEMORYTYPE_HOST = 1;
const CU_MEMORYTYPE_DEVICE = 2;

let initialised = false;

/** cuInit + retain the primary context of GPU `ordinal` and make it current on this thread. Returns the CUcontext. */
export function cudaCreateContext(ordinal = 0): bigint {
  if (!initialised) {
    ck(cuda.symbols.cuInit(0) as number, "cuInit");
    initialised = true;
  }
  const dev = new OutU32();
  ck(cuda.symbols.cuDeviceGet(dev.ptr, ordinal) as number, "cuDeviceGet");
  const ctx = new OutU64();
  ck(cuda.symbols.cuDevicePrimaryCtxRetain(ctx.ptr, dev.value | 0) as number, "cuDevicePrimaryCtxRetain");
  ck(cuda.symbols.cuCtxPushCurrent_v2(ctx.value) as number, "cuCtxPushCurrent");
  return ctx.value;
}

export function cudaDeviceCount(): number {
  if (!initialised) {
    ck(cuda.symbols.cuInit(0) as number, "cuInit");
    initialised = true;
  }
  const out = new OutU32();
  ck(cuda.symbols.cuDeviceGetCount(out.ptr) as number, "cuDeviceGetCount");
  return out.value;
}

export function cudaSynchronize(): void {
  ck(cuda.symbols.cuCtxSynchronize() as number, "cuCtxSynchronize");
}

/** Allocate `bytes` of device memory; returns the CUdeviceptr. */
export function cudaMalloc(bytes: number): bigint {
  const out = new OutU64();
  ck(cuda.symbols.cuMemAlloc_v2(out.ptr, BigInt(bytes)) as number, "cuMemAlloc");
  return out.value;
}

/** Free device memory previously returned by cudaMalloc. */
export function cudaFree(device: bigint): void {
  ck(cuda.symbols.cuMemFree_v2(device) as number, "cuMemFree");
}

/** Copy `bytes` from a host buffer into a device pointer (tightly packed). */
export function cudaMemcpyHtoD(dst: bigint, src: Uint8Array, bytes: number): void {
  ck(cuda.symbols.cuMemcpyHtoD_v2(dst, ptr(src), BigInt(bytes)) as number, "cuMemcpyHtoD");
}

/** Copy `bytes` from a device pointer into a host buffer (tightly packed). */
export function cudaMemcpyDtoH(dst: Uint8Array, src: bigint, bytes: number): void {
  ck(cuda.symbols.cuMemcpyDtoH_v2(ptr(dst), src, BigInt(bytes)) as number, "cuMemcpyDtoH");
}

/**
 * 2D host→device copy respecting the device pitch (NVOFA buffers are
 * pitch-linear). Builds a CUDA_MEMCPY2D (128-byte, v2) descriptor.
 */
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
  // src: XInBytes@0, Y@8, memoryType@16, host@24, device@32, array@40, pitch@48
  dv.setBigUint64(16, BigInt(CU_MEMORYTYPE_HOST), true);
  dv.setBigUint64(24, BigInt(ptr(opts.src)), true);
  dv.setBigUint64(48, BigInt(opts.srcPitch), true);
  // dst: XInBytes@56, Y@64, memoryType@72, host@80, device@88, array@96, pitch@104
  dv.setBigUint64(72, BigInt(CU_MEMORYTYPE_DEVICE), true);
  dv.setBigUint64(88, opts.dstDevice, true);
  dv.setBigUint64(104, BigInt(opts.dstPitch), true);
  dv.setBigUint64(112, BigInt(opts.widthBytes), true);
  dv.setBigUint64(120, BigInt(opts.height), true);
  ck(cuda.symbols.cuMemcpy2D_v2(ptr(desc)) as number, "cuMemcpy2D");
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
  ck(cuda.symbols.cuMemcpy2D_v2(ptr(desc)) as number, "cuMemcpy2D");
}
