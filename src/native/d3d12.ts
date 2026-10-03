/**
 * Direct3D 12 through bun:ffi: device, queue, command list, fence, committed
 * resources, and the linear layout a texture takes when copied through a buffer.
 *
 * Vtable indices come from d3d12.h; each interface's methods follow those of
 * its parent interface (IUnknown = 3 slots, ID3D12Object = 4, ...).
 */
import { dlopen, FFIType } from "bun:ffi";
import { ComObject, checkHresult, isFailure } from "./com.ts";
import type { DxgiAdapter } from "./dxgi.ts";
import { NativeStruct, OutPointer, align, guid } from "./memory.ts";
import { Win32Event } from "./win32.ts";

const d3d12 = dlopen("d3d12.dll", {
  D3D12CreateDevice: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  D3D12GetDebugInterface: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});

export const IID_ID3D12Device = guid("{189819f1-1db6-4b57-be54-1821339b85f7}");
export const IID_ID3D12CommandQueue = guid("{0ec870a6-5d7e-4c22-8cfc-5baae07616ed}");
export const IID_ID3D12CommandAllocator = guid("{6102dee4-af59-4b09-b999-b44d73f09b24}");
export const IID_ID3D12GraphicsCommandList = guid("{5b160d0f-ac1b-4185-8ba8-b3ae42a5a455}");
export const IID_ID3D12Fence = guid("{0a753dcf-c4d8-4b91-adf6-be5a60d95a76}");
export const IID_ID3D12Resource = guid("{696442be-a72e-4059-bc79-5b5c98040fad}");
export const IID_ID3D12Debug = guid("{344488b7-6846-474b-b989-f027448245e0}");

export const D3D_FEATURE_LEVEL_11_0 = 0xb000;

export const D3D12_COMMAND_LIST_TYPE_DIRECT = 0;

export const D3D12_HEAP_TYPE_DEFAULT = 1;
export const D3D12_HEAP_TYPE_UPLOAD = 2;
export const D3D12_HEAP_TYPE_READBACK = 3;

// Sharing flags for CUDA (or cross-process) interop.
export const D3D12_HEAP_FLAG_SHARED = 0x1;
export const D3D12_FENCE_FLAG_SHARED = 0x1; // 0x2 is SHARED_CROSS_ADAPTER — not what we want
// Access mask for ID3D12Device::CreateSharedHandle (currently unused by the API; GENERIC_ALL recommended).
export const GENERIC_ALL = 0x10000000;

export const D3D12_RESOURCE_DIMENSION_BUFFER = 1;
export const D3D12_RESOURCE_DIMENSION_TEXTURE2D = 3;
export const D3D12_TEXTURE_LAYOUT_UNKNOWN = 0;
export const D3D12_TEXTURE_LAYOUT_ROW_MAJOR = 1;
export const D3D12_RESOURCE_FLAG_NONE = 0;
export const D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS = 0x4;

export const D3D12_RESOURCE_STATE_COMMON = 0;
export const D3D12_RESOURCE_STATE_UNORDERED_ACCESS = 0x8;
export const D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE = 0x40;
export const D3D12_RESOURCE_STATE_COPY_DEST = 0x400;
export const D3D12_RESOURCE_STATE_COPY_SOURCE = 0x800;
export const D3D12_RESOURCE_STATE_GENERIC_READ = 0xac3;

export const DXGI_FORMAT_UNKNOWN = 0;
export const DXGI_FORMAT_R16G16B16A16_FLOAT = 10;
export const DXGI_FORMAT_R32G32_FLOAT = 16;
export const DXGI_FORMAT_R8G8B8A8_UNORM = 28;
export const DXGI_FORMAT_R16G16_FLOAT = 34;
export const DXGI_FORMAT_D32_FLOAT = 40;
export const DXGI_FORMAT_R32_FLOAT = 41;

export const D3D12_TEXTURE_DATA_PITCH_ALIGNMENT = 256;
export const D3D12_TEXTURE_DATA_PLACEMENT_ALIGNMENT = 512;

export function bytesPerPixel(format: number): number {
  switch (format) {
    case DXGI_FORMAT_R16G16B16A16_FLOAT:
    case DXGI_FORMAT_R32G32_FLOAT:
      return 8;
    case DXGI_FORMAT_R8G8B8A8_UNORM:
    case DXGI_FORMAT_R16G16_FLOAT:
    case DXGI_FORMAT_R32_FLOAT:
    case DXGI_FORMAT_D32_FLOAT:
      return 4;
    default:
      throw new Error(`bytesPerPixel: unsupported DXGI_FORMAT ${format}`);
  }
}

export function formatName(format: number): string {
  switch (format) {
    case DXGI_FORMAT_R16G16B16A16_FLOAT:
      return "R16G16B16A16_FLOAT";
    case DXGI_FORMAT_R32G32_FLOAT:
      return "R32G32_FLOAT";
    case DXGI_FORMAT_R8G8B8A8_UNORM:
      return "R8G8B8A8_UNORM";
    case DXGI_FORMAT_R16G16_FLOAT:
      return "R16G16_FLOAT";
    case DXGI_FORMAT_R32_FLOAT:
      return "R32_FLOAT";
    case DXGI_FORMAT_D32_FLOAT:
      return "D32_FLOAT";
    default:
      return `DXGI_FORMAT(${format})`;
  }
}

function heapProperties(type: number): NativeStruct {
  // D3D12_HEAP_PROPERTIES (d3d12.h, 20 bytes): Type, CPUPageProperty,
  // MemoryPoolPreference, CreationNodeMask, VisibleNodeMask. Node masks are 1
  // because everything here is single-adapter.
  return new NativeStruct(20).u32(0, type).u32(4, 0).u32(8, 0).u32(12, 1).u32(16, 1);
}

// D3D12_RESOURCE_DESC (d3d12.h, x64, 56 bytes): Dimension u32 @0; Alignment u64 @8;
// Width u64 @16; Height u32 @24; DepthOrArraySize u16 @28; MipLevels u16 @30;
// Format u32 @32; SampleDesc{Count @36, Quality @40}; Layout u32 @44; Flags u32 @48.
// A buffer must be ROW_MAJOR with Height/Depth/MipLevels 1 and format UNKNOWN.
function bufferDescription(sizeInBytes: number, flags: number): NativeStruct {
  const desc = new NativeStruct(56);
  desc.u32(0, D3D12_RESOURCE_DIMENSION_BUFFER);
  desc.u64(8, 0);
  desc.u64(16, sizeInBytes);
  desc.u32(24, 1);
  desc.u16(28, 1);
  desc.u16(30, 1);
  desc.u32(32, DXGI_FORMAT_UNKNOWN);
  desc.u32(36, 1);
  desc.u32(40, 0);
  desc.u32(44, D3D12_TEXTURE_LAYOUT_ROW_MAJOR);
  desc.u32(48, flags);
  return desc;
}

function texture2dDescription(width: number, height: number, format: number, flags: number): NativeStruct {
  const desc = new NativeStruct(56);
  desc.u32(0, D3D12_RESOURCE_DIMENSION_TEXTURE2D);
  desc.u64(8, 0);
  desc.u64(16, width);
  desc.u32(24, height);
  desc.u16(28, 1);
  desc.u16(30, 1);
  desc.u32(32, format);
  desc.u32(36, 1);
  desc.u32(40, 0);
  desc.u32(44, D3D12_TEXTURE_LAYOUT_UNKNOWN);
  desc.u32(48, flags);
  return desc;
}

export interface TextureOptions {
  width: number;
  height: number;
  format: number;
  allowUnorderedAccess?: boolean;
  initialState?: number;
  label?: string;
}

export class D3D12Resource extends ComObject {
  /** Resource state as last recorded by this process; barriers are derived from it. */
  state: number;

  constructor(
    ptr: number,
    label: string,
    readonly kind: "buffer" | "texture2d",
    readonly width: number,
    readonly height: number,
    readonly format: number,
    readonly sizeInBytes: number,
    initialState: number,
  ) {
    super(ptr, label);
    this.state = initialState;
  }

  /** Map subresource 0 and return the CPU address. A null `readRange` means "may read everything"; `{begin:0,end:0}` promises the CPU will not read. */
  map(readRange: { begin: number; end: number } | null = null): number {
    const out = new OutPointer();
    const range = readRange ? new NativeStruct(16).u64(0, readRange.begin).u64(8, readRange.end) : null;
    this.callHr(8, { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, "Map", 0, range ? range.bytes : null, out.bytes);
    return out.value;
  }

  unmap(writtenRange: { begin: number; end: number } | null = null): void {
    const range = writtenRange ? new NativeStruct(16).u64(0, writtenRange.begin).u64(8, writtenRange.end) : null;
    this.call(9, { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void }, 0, range ? range.bytes : null);
  }
}

export class D3D12Fence extends ComObject {
  completedValue(): bigint {
    return BigInt(this.call(8, { args: [], returns: FFIType.u64 }) as bigint | number);
  }

  setEventOnCompletion(value: bigint, event: Win32Event): void {
    this.callHr(9, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }, "SetEventOnCompletion", value, event.handle);
  }
}

export class D3D12CommandAllocator extends ComObject {
  reset(): void {
    this.callHr(8, { args: [], returns: FFIType.i32 }, "Reset");
  }
}

export class D3D12CommandQueue extends ComObject {
  executeCommandList(list: D3D12GraphicsCommandList): void {
    const cell = new NativeStruct(8).pointer(0, list.ptr);
    this.call(10, { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void }, 1, cell.bytes);
  }

  signal(fence: D3D12Fence, value: bigint): void {
    this.callHr(14, { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 }, "Signal", fence.ptr, value);
  }
}

export interface CopyLocation {
  resource: D3D12Resource;
  /** For buffers: describes the texture layout inside the buffer. */
  footprint?: { offset: number; format: number; width: number; height: number; rowPitch: number };
}

interface BufferLocation {
  resource: D3D12Resource;
  offset: number;
}

function copyLocation(location: CopyLocation): NativeStruct {
  // D3D12_TEXTURE_COPY_LOCATION (d3d12.h, x64, 48 bytes): pResource @0; Type u32 @8;
  // then a union at @16 — either PlacedFootprint{Offset u64 @16, Format @24, Width @28,
  // Height @32, Depth @36, RowPitch @40} or SubresourceIndex u32 @16.
  const s = new NativeStruct(48);
  s.pointer(0, location.resource.ptr);
  if (location.footprint) {
    s.u32(8, 1); // D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT
    s.u64(16, location.footprint.offset);
    s.u32(24, location.footprint.format);
    s.u32(28, location.footprint.width);
    s.u32(32, location.footprint.height);
    s.u32(36, 1);
    s.u32(40, location.footprint.rowPitch);
  } else {
    s.u32(8, 0); // D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX
    s.u32(16, 0);
  }
  return s;
}

export class D3D12GraphicsCommandList extends ComObject {
  private open = true;
  private readonly transitionedBuffers = new Set<D3D12Resource>();

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Buffers decay to COMMON once the ExecuteCommandLists that ran this list completes
   * ("State decay to common", Microsoft Learn: Using resource barriers to synchronize
   * resource states in Direct3D 12). Every list this process records next runs after
   * this one on the same queue, so their barriers must start buffers from COMMON.
   */
  close(): void {
    if (!this.open) return;
    this.callHr(9, { args: [], returns: FFIType.i32 }, "Close");
    this.open = false;
    for (const buffer of this.transitionedBuffers) buffer.state = D3D12_RESOURCE_STATE_COMMON;
    this.transitionedBuffers.clear();
  }

  reset(allocator: D3D12CommandAllocator): void {
    this.callHr(10, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, "Reset", allocator.ptr, null);
    this.open = true;
  }

  /**
   * ID3D12GraphicsCommandList::CopyBufferRegion(pDstBuffer, DstOffset, pSrcBuffer,
   * SrcOffset, NumBytes), vtable slot 15: d3d12.h lists Close 9, Reset 10,
   * ClearState 11, DrawInstanced 12, DrawIndexedInstanced 13, Dispatch 14 before it.
   */
  copyBufferRegion(dst: BufferLocation, src: BufferLocation, byteCount: number): void {
    this.call(
      15,
      { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.void },
      dst.resource.ptr,
      BigInt(dst.offset),
      src.resource.ptr,
      BigInt(src.offset),
      BigInt(byteCount),
    );
  }

  copyTextureRegion(dst: CopyLocation, src: CopyLocation): void {
    const d = copyLocation(dst);
    const s = copyLocation(src);
    this.call(
      16,
      { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
      d.bytes,
      0,
      0,
      0,
      s.bytes,
      null,
    );
  }

  copyResource(dst: D3D12Resource, src: D3D12Resource): void {
    this.call(17, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void }, dst.ptr, src.ptr);
  }

  /** Record a transition barrier when the tracked state differs from `newState`. */
  transition(resource: D3D12Resource, newState: number): void {
    if (resource.state === newState) return;
    const barrier = new NativeStruct(32);
    barrier.u32(0, 0); // D3D12_RESOURCE_BARRIER_TYPE_TRANSITION
    barrier.u32(4, 0);
    barrier.pointer(8, resource.ptr);
    barrier.u32(16, 0xffffffff); // D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES
    barrier.u32(20, resource.state);
    barrier.u32(24, newState);
    this.call(26, { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void }, 1, barrier.bytes);
    resource.state = newState;
    if (resource.kind === "buffer") this.transitionedBuffers.add(resource);
  }

  uavBarrier(resource: D3D12Resource): void {
    const barrier = new NativeStruct(32);
    barrier.u32(0, 2); // D3D12_RESOURCE_BARRIER_TYPE_UAV
    barrier.pointer(8, resource.ptr);
    this.call(26, { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void }, 1, barrier.bytes);
  }
}

export interface DeviceOptions {
  featureLevel?: number;
  debugLayer?: boolean;
}

export class D3D12Device extends ComObject {
  readonly featureLevel: number;

  private constructor(ptr: number, featureLevel: number) {
    super(ptr, "ID3D12Device");
    this.featureLevel = featureLevel;
  }

  static enableDebugLayer(): boolean {
    const out = new OutPointer();
    const hr = d3d12.symbols.D3D12GetDebugInterface(IID_ID3D12Debug, out.bytes);
    if (isFailure(hr) || out.value === 0) return false;
    const debug = new ComObject(out.value, "ID3D12Debug");
    (debug as unknown as { call: ComObject["call"] }).call.call(debug, 3, { args: [], returns: FFIType.void });
    debug.release();
    return true;
  }

  static create(adapter: DxgiAdapter | null, options: DeviceOptions = {}): D3D12Device {
    if (options.debugLayer) D3D12Device.enableDebugLayer();
    const featureLevel = options.featureLevel ?? D3D_FEATURE_LEVEL_11_0;
    const out = new OutPointer();
    const hr = d3d12.symbols.D3D12CreateDevice(adapter ? adapter.ptr : null, featureLevel, IID_ID3D12Device, out.bytes);
    checkHresult(hr, "D3D12CreateDevice");
    return new D3D12Device(out.value, featureLevel);
  }

  createCommandQueue(type = D3D12_COMMAND_LIST_TYPE_DIRECT): D3D12CommandQueue {
    const desc = new NativeStruct(16).u32(0, type).i32(4, 0).u32(8, 0).u32(12, 0);
    const out = new OutPointer();
    this.callHr(8, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, "CreateCommandQueue", desc.bytes, IID_ID3D12CommandQueue, out.bytes);
    return new D3D12CommandQueue(out.value, "ID3D12CommandQueue");
  }

  createCommandAllocator(type = D3D12_COMMAND_LIST_TYPE_DIRECT): D3D12CommandAllocator {
    const out = new OutPointer();
    this.callHr(9, { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, "CreateCommandAllocator", type, IID_ID3D12CommandAllocator, out.bytes);
    return new D3D12CommandAllocator(out.value, "ID3D12CommandAllocator");
  }

  createCommandList(allocator: D3D12CommandAllocator, type = D3D12_COMMAND_LIST_TYPE_DIRECT): D3D12GraphicsCommandList {
    const out = new OutPointer();
    this.callHr(
      12,
      { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      "CreateCommandList",
      0,
      type,
      allocator.ptr,
      null,
      IID_ID3D12GraphicsCommandList,
      out.bytes,
    );
    return new D3D12GraphicsCommandList(out.value, "ID3D12GraphicsCommandList");
  }

  createFence(initialValue = 0n, flags = 0): D3D12Fence {
    const out = new OutPointer();
    this.callHr(36, { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, "CreateFence", initialValue, flags, IID_ID3D12Fence, out.bytes);
    return new D3D12Fence(out.value, "ID3D12Fence");
  }

  /** A fence created with D3D12_FENCE_FLAG_SHARED so a Win32 NT handle can be minted for CUDA external-semaphore interop. */
  createSharedFence(initialValue = 0n): D3D12Fence {
    return this.createFence(initialValue, D3D12_FENCE_FLAG_SHARED);
  }

  /**
   * Mint a Win32 NT HANDLE for a resource or fence that was created with the
   * matching SHARED flag. The caller owns the handle and must CloseHandle it once
   * CUDA has imported (and duplicated) it.
   */
  createSharedHandle(object: ComObject): number {
    const out = new OutPointer();
    this.callHr(
      31,
      { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      "CreateSharedHandle",
      object.ptr,
      null,
      GENERIC_ALL,
      null,
      out.bytes,
    );
    return out.value;
  }

  deviceRemovedReason(): number {
    return this.call(37, { args: [], returns: FFIType.i32 }) as number;
  }

  private createCommitted(heapType: number, desc: NativeStruct, initialState: number, label: string, heapFlags = 0): number {
    const heap = heapProperties(heapType);
    const out = new OutPointer();
    this.callHr(
      27,
      { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      `CreateCommittedResource(${label})`,
      heap.bytes,
      heapFlags,
      desc.bytes,
      initialState,
      null,
      IID_ID3D12Resource,
      out.bytes,
    );
    return out.value;
  }

  /**
   * A DEFAULT-heap committed buffer with HEAP_FLAG_SHARED, so createSharedHandle
   * can mint an NT handle for CUDA to import as external memory. Starts in COMMON.
   */
  createSharedBuffer(sizeInBytes: number, label = `shared buffer ${sizeInBytes}B`): D3D12Resource {
    const ptr = this.createCommitted(D3D12_HEAP_TYPE_DEFAULT, bufferDescription(sizeInBytes, D3D12_RESOURCE_FLAG_NONE), D3D12_RESOURCE_STATE_COMMON, label, D3D12_HEAP_FLAG_SHARED);
    return new D3D12Resource(ptr, label, "buffer", sizeInBytes, 1, DXGI_FORMAT_UNKNOWN, sizeInBytes, D3D12_RESOURCE_STATE_COMMON);
  }

  /**
   * A DEFAULT-heap committed buffer with ALLOW_UNORDERED_ACCESS, for a feature
   * that writes a buffer output through a UAV; the CPU reaches it only through
   * GPU copies (GpuContext.fillBuffers, GpuContext.readbackMany). Starts in COMMON.
   */
  createUnorderedAccessBuffer(sizeInBytes: number, label = `UAV buffer ${sizeInBytes}B`): D3D12Resource {
    const ptr = this.createCommitted(D3D12_HEAP_TYPE_DEFAULT, bufferDescription(sizeInBytes, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS), D3D12_RESOURCE_STATE_COMMON, label);
    return new D3D12Resource(ptr, label, "buffer", sizeInBytes, 1, DXGI_FORMAT_UNKNOWN, sizeInBytes, D3D12_RESOURCE_STATE_COMMON);
  }

  createTexture2D(options: TextureOptions): D3D12Resource {
    const flags = options.allowUnorderedAccess ? D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS : D3D12_RESOURCE_FLAG_NONE;
    const state = options.initialState ?? D3D12_RESOURCE_STATE_COMMON;
    const label = options.label ?? `texture ${options.width}x${options.height} ${formatName(options.format)}`;
    const ptr = this.createCommitted(D3D12_HEAP_TYPE_DEFAULT, texture2dDescription(options.width, options.height, options.format, flags), state, label);
    const size = options.width * options.height * bytesPerPixel(options.format);
    return new D3D12Resource(ptr, label, "texture2d", options.width, options.height, options.format, size, state);
  }

  createBuffer(sizeInBytes: number, heapType: number, label = `buffer ${sizeInBytes}B`): D3D12Resource {
    const state =
      heapType === D3D12_HEAP_TYPE_UPLOAD
        ? D3D12_RESOURCE_STATE_GENERIC_READ
        : heapType === D3D12_HEAP_TYPE_READBACK
          ? D3D12_RESOURCE_STATE_COPY_DEST
          : D3D12_RESOURCE_STATE_COMMON;
    const ptr = this.createCommitted(heapType, bufferDescription(sizeInBytes, D3D12_RESOURCE_FLAG_NONE), state, label);
    return new D3D12Resource(ptr, label, "buffer", sizeInBytes, 1, DXGI_FORMAT_UNKNOWN, sizeInBytes, state);
  }
}

/** Layout of a 2D texture when laid out linearly in a buffer, as D3D12 copies require. */
export function linearLayout(width: number, height: number, format: number): { rowBytes: number; rowPitch: number; totalBytes: number } {
  const rowBytes = width * bytesPerPixel(format);
  const rowPitch = align(rowBytes, D3D12_TEXTURE_DATA_PITCH_ALIGNMENT);
  return { rowBytes, rowPitch, totalBytes: align(rowPitch * height, D3D12_TEXTURE_DATA_PLACEMENT_ALIGNMENT) };
}
