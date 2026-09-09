/**
 * D3D12 <-> CUDA zero-copy interop via the CUDA Driver API external-memory and
 * external-semaphore entry points (nvcuda.dll).
 *
 * DLSS must run on D3D12, and NVENC runs on CUDA. To keep a frame on the GPU
 * across that boundary we share a D3D12 committed buffer (created with
 * HEAP_FLAG_SHARED) with CUDA: mint a Win32 NT handle for it
 * (ID3D12Device::CreateSharedHandle), import it as CUDA external memory, and map
 * it to a CUdeviceptr that NVENC can register — no CPU readback/upload. A shared
 * D3D12 fence, imported as a CUDA external semaphore, orders the two engines.
 *
 * ABI: CUDA Driver API (cuda.h). Natural alignment, x64. CUresult 0 = SUCCESS.
 * Handles (CUexternalMemory / CUexternalSemaphore / CUdeviceptr) are 8-byte,
 * carried as bigint. The imported NT handle is duplicated by CUDA on import, so
 * the original must be CloseHandle'd afterwards (kernel32).
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { OutU64 } from "./memory.ts";

const cuda = dlopen("nvcuda.dll", {
  cuImportExternalMemory: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  cuExternalMemoryGetMappedBuffer: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  cuDestroyExternalMemory: { args: [FFIType.u64], returns: FFIType.i32 },
  cuImportExternalSemaphore: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  cuSignalExternalSemaphoresAsync: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  cuWaitExternalSemaphoresAsync: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  cuDestroyExternalSemaphore: { args: [FFIType.u64], returns: FFIType.i32 },
});

const kernel32 = dlopen("kernel32.dll", {
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
});

function ck(r: number, what: string): void {
  if (r !== 0) throw new Error(`CUDA interop ${what} failed: CUresult ${r}`);
}

// CUexternalMemoryHandleType / CUexternalSemaphoreHandleType
const HANDLE_TYPE_D3D12_RESOURCE = 5;
const SEM_HANDLE_TYPE_D3D12_FENCE = 4;
// CUDA_EXTERNAL_MEMORY_DEDICATED — required for a D3D12 committed resource.
const CUDA_EXTERNAL_MEMORY_DEDICATED = 0x1;

/** Close a Win32 NT handle (after CUDA has imported/duplicated it). */
export function closeHandle(handle: number): void {
  kernel32.symbols.CloseHandle(BigInt(handle));
}

export interface ImportedBuffer {
  extMem: bigint;
  devPtr: bigint;
}

/**
 * Import a shared D3D12 committed buffer (via its NT handle) as CUDA external
 * memory and map it to a CUdeviceptr of `size` bytes. The returned devPtr aliases
 * the same physical VRAM as the D3D12 resource. Does NOT close the handle.
 */
export function importD3D12Buffer(sharedHandle: number, size: number): ImportedBuffer {
  // CUDA_EXTERNAL_MEMORY_HANDLE_DESC (x64, 104 bytes):
  //   type u32 @0; pad @4; win32{handle ptr @8, name ptr @16}; size u64 @24;
  //   flags u32 @32; reserved[16] @36.
  const desc = new Uint8Array(104);
  const dv = new DataView(desc.buffer);
  dv.setUint32(0, HANDLE_TYPE_D3D12_RESOURCE, true);
  dv.setBigUint64(8, BigInt(sharedHandle), true); // win32.handle
  // win32.name @16 = NULL
  dv.setBigUint64(24, BigInt(size), true);
  dv.setUint32(32, CUDA_EXTERNAL_MEMORY_DEDICATED, true);
  const extOut = new OutU64();
  ck(cuda.symbols.cuImportExternalMemory(extOut.ptr, ptr(desc)) as number, "cuImportExternalMemory");
  const extMem = extOut.value;

  // CUDA_EXTERNAL_MEMORY_BUFFER_DESC (x64, 88 bytes): offset u64 @0; size u64 @8;
  //   flags u32 @16; reserved[16] @20.
  const bufDesc = new Uint8Array(88);
  new DataView(bufDesc.buffer).setBigUint64(8, BigInt(size), true); // size @8, offset @0 = 0
  const devOut = new OutU64();
  ck(cuda.symbols.cuExternalMemoryGetMappedBuffer(devOut.ptr, extMem, ptr(bufDesc)) as number, "cuExternalMemoryGetMappedBuffer");
  return { extMem, devPtr: devOut.value };
}

export function destroyExternalMemory(extMem: bigint): void {
  ck(cuda.symbols.cuDestroyExternalMemory(extMem) as number, "cuDestroyExternalMemory");
}

/** Import a shared D3D12 fence (via its NT handle) as a CUDA external semaphore. */
export function importD3D12Fence(sharedHandle: number): bigint {
  // CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC (x64, 96 bytes):
  //   type u32 @0; pad @4; win32{handle ptr @8, name ptr @16}; flags u32 @24; reserved[16] @28.
  const desc = new Uint8Array(96);
  const dv = new DataView(desc.buffer);
  dv.setUint32(0, SEM_HANDLE_TYPE_D3D12_FENCE, true);
  dv.setBigUint64(8, BigInt(sharedHandle), true);
  const out = new OutU64();
  ck(cuda.symbols.cuImportExternalSemaphore(out.ptr, ptr(desc)) as number, "cuImportExternalSemaphore");
  return out.value;
}

/** Make the CUDA stream wait until the shared D3D12 fence reaches `value`. */
export function waitExternalSemaphore(extSem: bigint, value: bigint, stream = 0n): void {
  const semArray = new Uint8Array(8);
  new DataView(semArray.buffer).setBigUint64(0, extSem, true);
  // CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS (x64, 144 bytes): params.fence.value u64 @0; ... flags u32 @72.
  const params = new Uint8Array(144);
  new DataView(params.buffer).setBigUint64(0, value, true);
  ck(cuda.symbols.cuWaitExternalSemaphoresAsync(ptr(semArray), ptr(params), 1, stream) as number, "cuWaitExternalSemaphoresAsync");
}

/** Signal the shared D3D12 fence to `value` from the CUDA stream. */
export function signalExternalSemaphore(extSem: bigint, value: bigint, stream = 0n): void {
  const semArray = new Uint8Array(8);
  new DataView(semArray.buffer).setBigUint64(0, extSem, true);
  // CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS (x64, 144 bytes): params.fence.value u64 @0; flags u32 @72.
  const params = new Uint8Array(144);
  new DataView(params.buffer).setBigUint64(0, value, true);
  ck(cuda.symbols.cuSignalExternalSemaphoresAsync(ptr(semArray), ptr(params), 1, stream) as number, "cuSignalExternalSemaphoresAsync");
}

export function destroyExternalSemaphore(extSem: bigint): void {
  ck(cuda.symbols.cuDestroyExternalSemaphore(extSem) as number, "cuDestroyExternalSemaphore");
}
