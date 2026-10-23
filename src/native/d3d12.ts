/**
 * Direct3D 12 through bun:ffi: device, queue, command list, fence, committed
 * resources, and the linear layout a texture takes when copied through a buffer.
 *
 * Vtable indices come from d3d12.h; each interface's methods follow those of
 * its parent interface (IUnknown = 3 slots, ID3D12Object = 4, ...).
 */
import { dlopen, FFIType } from "bun:ffi";
import { ComObject, checkHresult, describeHresult, isFailure } from "./com.ts";
import type { DxgiAdapter } from "./dxgi.ts";
import { NativeStruct, OutPointer, align, guid, hex32 } from "./memory.ts";
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
const D3D12_HEAP_FLAG_SHARED = 0x1;
const D3D12_FENCE_FLAG_SHARED = 0x1; // Same-adapter sharing with CUDA; SHARED_CROSS_ADAPTER (0x2) is for fences shared across adapters.
// Access mask for ID3D12Device::CreateSharedHandle: the only value it currently accepts is GENERIC_ALL (Microsoft Learn, ID3D12Device::CreateSharedHandle).
const GENERIC_ALL = 0x10000000;

const D3D12_RESOURCE_DIMENSION_BUFFER = 1;
const D3D12_RESOURCE_DIMENSION_TEXTURE2D = 3;
const D3D12_TEXTURE_LAYOUT_UNKNOWN = 0;
const D3D12_TEXTURE_LAYOUT_ROW_MAJOR = 1;
const D3D12_RESOURCE_FLAG_NONE = 0;
const D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS = 0x4;
const D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX = 0;
const D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT = 1;
const D3D12_RESOURCE_BARRIER_TYPE_TRANSITION = 0;
const D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES = 0xffffffff;

export const D3D12_RESOURCE_STATE_COMMON = 0;
export const D3D12_RESOURCE_STATE_UNORDERED_ACCESS = 0x8;
export const D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE = 0x40;
export const D3D12_RESOURCE_STATE_COPY_DEST = 0x400;
export const D3D12_RESOURCE_STATE_COPY_SOURCE = 0x800;
export const D3D12_RESOURCE_STATE_GENERIC_READ = 0xac3;

const DXGI_FORMAT_UNKNOWN = 0;
export const DXGI_FORMAT_R8G8B8A8_UNORM = 28;
export const DXGI_FORMAT_R16G16_FLOAT = 34;
export const DXGI_FORMAT_R32_FLOAT = 41;

export const D3D12_TEXTURE_DATA_PITCH_ALIGNMENT = 256;
const D3D12_TEXTURE_DATA_PLACEMENT_ALIGNMENT = 512;

/**
 * How long a CPU wait for the GPU lasts before the GPU counts as hung: far longer than any one submit here takes,
 * while Windows' TDR (2 s by default) removes the device of a GPU that really hangs well before it.
 */
export const FENCE_WAIT_TIMEOUT_MS = 30_000;

/** The error for a GPU wait that ran out of time on a device that is still present. */
export function gpuTimeoutError(what: string, timeoutMs: number): Error {
  return new Error(`${what}: the GPU did not finish within ${timeoutMs} ms; another program may be holding it. Free the GPU or lower the workload, then retry.`);
}

/** The DXGI formats this project creates resources in. */
const FORMATS: ReadonlyMap<number, { name: string; bytesPerPixel: number }> = new Map([
  [DXGI_FORMAT_R8G8B8A8_UNORM, { name: "R8G8B8A8_UNORM", bytesPerPixel: 4 }],
  [DXGI_FORMAT_R16G16_FLOAT, { name: "R16G16_FLOAT", bytesPerPixel: 4 }],
  [DXGI_FORMAT_R32_FLOAT, { name: "R32_FLOAT", bytesPerPixel: 4 }],
]);

export function bytesPerPixel(format: number): number {
  const entry = FORMATS.get(format);
  if (!entry) throw new Error(`bytesPerPixel: unsupported DXGI_FORMAT ${format}`);
  return entry.bytesPerPixel;
}

export function formatName(format: number): string {
  return FORMATS.get(format)?.name ?? `DXGI_FORMAT(${format})`;
}

function heapProperties(type: number): NativeStruct {
  // D3D12_HEAP_PROPERTIES (d3d12.h, 20 bytes): Type, CPUPageProperty,
  // MemoryPoolPreference, CreationNodeMask, VisibleNodeMask. Node masks are 1
  // because everything here is single-adapter.
  return new NativeStruct(20).u32(0, type).u32(4, 0).u32(8, 0).u32(12, 1).u32(16, 1);
}

/** What a resource is: a buffer carries its byte size as its width, with height 1 and no format, as D3D12 describes one. */
interface ResourceShape {
  kind: "buffer" | "texture2d";
  width: number;
  height: number;
  format: number;
  sizeInBytes: number;
}

function bufferShape(sizeInBytes: number): ResourceShape {
  return { kind: "buffer", width: sizeInBytes, height: 1, format: DXGI_FORMAT_UNKNOWN, sizeInBytes };
}

// D3D12_RESOURCE_DESC (d3d12.h, x64, 56 bytes): Dimension u32 @0; Alignment u64 @8;
// Width u64 @16; Height u32 @24; DepthOrArraySize u16 @28; MipLevels u16 @30;
// Format u32 @32; SampleDesc{Count @36, Quality @40}; Layout u32 @44; Flags u32 @48.
// A buffer must be ROW_MAJOR with Height/Depth/MipLevels 1 and format UNKNOWN.
function resourceDescription(shape: ResourceShape, flags: number): NativeStruct {
  const buffer = shape.kind === "buffer";
  const desc = new NativeStruct(56);
  desc.u32(0, buffer ? D3D12_RESOURCE_DIMENSION_BUFFER : D3D12_RESOURCE_DIMENSION_TEXTURE2D);
  desc.u64(8, 0);
  desc.u64(16, shape.width);
  desc.u32(24, shape.height);
  desc.u16(28, 1);
  desc.u16(30, 1);
  desc.u32(32, shape.format);
  desc.u32(36, 1);
  desc.u32(40, 0);
  desc.u32(44, buffer ? D3D12_TEXTURE_LAYOUT_ROW_MAJOR : D3D12_TEXTURE_LAYOUT_UNKNOWN);
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
  readonly kind: ResourceShape["kind"];
  readonly width: number;
  readonly height: number;
  readonly format: number;
  readonly sizeInBytes: number;
  /** Resource state as last recorded by this process; barriers are derived from it. */
  state: number;

  constructor(ptr: number, options: ResourceShape & { label: string; initialState: number }) {
    super(ptr, options.label);
    this.kind = options.kind;
    this.width = options.width;
    this.height = options.height;
    this.format = options.format;
    this.sizeInBytes = options.sizeInBytes;
    this.state = options.initialState;
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

  /** Block until the fence reaches `value`, waiting on `event`; false when `timeoutMs` passes first. */
  waitFor(value: bigint, event: Win32Event, timeoutMs = FENCE_WAIT_TIMEOUT_MS): boolean {
    if (this.completedValue() >= value) return true;
    this.setEventOnCompletion(value, event);
    return event.wait(timeoutMs);
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
  const struct = new NativeStruct(48);
  struct.pointer(0, location.resource.ptr);
  if (location.footprint) {
    struct.u32(8, D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT);
    struct.u64(16, location.footprint.offset);
    struct.u32(24, location.footprint.format);
    struct.u32(28, location.footprint.width);
    struct.u32(32, location.footprint.height);
    struct.u32(36, 1);
    struct.u32(40, location.footprint.rowPitch);
  } else {
    struct.u32(8, D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX);
    struct.u32(16, 0);
  }
  return struct;
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
    const destination = copyLocation(dst);
    const source = copyLocation(src);
    this.call(
      16,
      { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
      destination.bytes,
      0,
      0,
      0,
      source.bytes,
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
    barrier.u32(0, D3D12_RESOURCE_BARRIER_TYPE_TRANSITION);
    barrier.u32(4, 0);
    barrier.pointer(8, resource.ptr);
    barrier.u32(16, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES);
    barrier.u32(20, resource.state);
    barrier.u32(24, newState);
    this.call(26, { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void }, 1, barrier.bytes);
    resource.state = newState;
    if (resource.kind === "buffer") this.transitionedBuffers.add(resource);
  }
}

/** ID3D12Debug (d3d12sdklayers.h): EnableDebugLayer is the first slot after IUnknown's 3. */
class D3D12Debug extends ComObject {
  enableDebugLayer(): void {
    this.call(3, { args: [], returns: FFIType.void });
  }
}

export interface DeviceOptions {
  debugLayer?: boolean;
}

export class D3D12Device extends ComObject {
  readonly featureLevel: number;

  private constructor(ptr: number, featureLevel: number) {
    super(ptr, "ID3D12Device");
    this.featureLevel = featureLevel;
  }

  /** Turns the D3D12 debug layer on for the devices created after it; throws when the Graphics Tools are not installed. */
  static enableDebugLayer(): void {
    const out = new OutPointer();
    const hr = d3d12.symbols.D3D12GetDebugInterface(IID_ID3D12Debug, out.bytes);
    if (isFailure(hr) || out.value === 0) {
      throw new Error(
        `The D3D12 debug layer is not available: D3D12GetDebugInterface returned HRESULT ${hex32(hr)}${describeHresult(hr)}. Install Graphics Tools (Settings > System > Optional features), or leave out --debug-layer.`,
      );
    }
    const debug = new D3D12Debug(out.value, "ID3D12Debug");
    debug.enableDebugLayer();
    debug.release();
  }

  static create(adapter: DxgiAdapter | null, options: DeviceOptions = {}): D3D12Device {
    if (options.debugLayer) D3D12Device.enableDebugLayer();
    const out = new OutPointer();
    const hr = d3d12.symbols.D3D12CreateDevice(adapter ? adapter.ptr : null, D3D_FEATURE_LEVEL_11_0, IID_ID3D12Device, out.bytes);
    checkHresult(hr, "D3D12CreateDevice");
    return new D3D12Device(out.value, D3D_FEATURE_LEVEL_11_0);
  }

  createCommandQueue(): D3D12CommandQueue {
    const desc = new NativeStruct(16).u32(0, D3D12_COMMAND_LIST_TYPE_DIRECT).i32(4, 0).u32(8, 0).u32(12, 0);
    const out = new OutPointer();
    this.callHr(8, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, "CreateCommandQueue", desc.bytes, IID_ID3D12CommandQueue, out.bytes);
    return new D3D12CommandQueue(out.value, "ID3D12CommandQueue");
  }

  createCommandAllocator(): D3D12CommandAllocator {
    const out = new OutPointer();
    this.callHr(9, { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, "CreateCommandAllocator", D3D12_COMMAND_LIST_TYPE_DIRECT, IID_ID3D12CommandAllocator, out.bytes);
    return new D3D12CommandAllocator(out.value, "ID3D12CommandAllocator");
  }

  createCommandList(allocator: D3D12CommandAllocator): D3D12GraphicsCommandList {
    const out = new OutPointer();
    this.callHr(
      12,
      { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      "CreateCommandList",
      0,
      D3D12_COMMAND_LIST_TYPE_DIRECT,
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

  /** The error to report for `what` when the device has been removed, or null while it is present. */
  removedError(what: string): Error | null {
    const reason = this.deviceRemovedReason();
    if (!isFailure(reason)) return null;
    return new Error(`${what}: the D3D12 device was removed (${hex32(reason)}${describeHresult(reason)}). Restart the job; if it repeats, update or reset the NVIDIA driver.`);
  }

  private createCommitted(options: { heapType: number; heapFlags?: number; shape: ResourceShape; resourceFlags: number; initialState: number; label: string }): D3D12Resource {
    const heap = heapProperties(options.heapType);
    const desc = resourceDescription(options.shape, options.resourceFlags);
    const out = new OutPointer();
    this.callHr(
      27,
      { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      `CreateCommittedResource(${options.label})`,
      heap.bytes,
      options.heapFlags ?? 0,
      desc.bytes,
      options.initialState,
      null,
      IID_ID3D12Resource,
      out.bytes,
    );
    return new D3D12Resource(out.value, { ...options.shape, label: options.label, initialState: options.initialState });
  }

  /**
   * A DEFAULT-heap committed buffer with HEAP_FLAG_SHARED, so createSharedHandle
   * can mint an NT handle for CUDA to import as external memory. Starts in COMMON.
   */
  createSharedBuffer(sizeInBytes: number, label = `shared buffer ${sizeInBytes}B`): D3D12Resource {
    return this.createCommitted({
      heapType: D3D12_HEAP_TYPE_DEFAULT,
      heapFlags: D3D12_HEAP_FLAG_SHARED,
      shape: bufferShape(sizeInBytes),
      resourceFlags: D3D12_RESOURCE_FLAG_NONE,
      initialState: D3D12_RESOURCE_STATE_COMMON,
      label,
    });
  }

  /**
   * A DEFAULT-heap committed buffer with ALLOW_UNORDERED_ACCESS, for a feature
   * that writes a buffer output through a UAV; the CPU reaches it only through
   * GPU copies (GpuContext.fillBuffers, GpuContext.readbackMany). Starts in COMMON.
   */
  createUnorderedAccessBuffer(sizeInBytes: number, label = `UAV buffer ${sizeInBytes}B`): D3D12Resource {
    return this.createCommitted({
      heapType: D3D12_HEAP_TYPE_DEFAULT,
      shape: bufferShape(sizeInBytes),
      resourceFlags: D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS,
      initialState: D3D12_RESOURCE_STATE_COMMON,
      label,
    });
  }

  createTexture2D(options: TextureOptions): D3D12Resource {
    return this.createCommitted({
      heapType: D3D12_HEAP_TYPE_DEFAULT,
      shape: { kind: "texture2d", width: options.width, height: options.height, format: options.format, sizeInBytes: options.width * options.height * bytesPerPixel(options.format) },
      resourceFlags: options.allowUnorderedAccess ? D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS : D3D12_RESOURCE_FLAG_NONE,
      initialState: options.initialState ?? D3D12_RESOURCE_STATE_COMMON,
      label: options.label ?? `texture ${options.width}x${options.height} ${formatName(options.format)}`,
    });
  }

  createBuffer(sizeInBytes: number, heapType: number, label = `buffer ${sizeInBytes}B`): D3D12Resource {
    const initialState =
      heapType === D3D12_HEAP_TYPE_UPLOAD
        ? D3D12_RESOURCE_STATE_GENERIC_READ
        : heapType === D3D12_HEAP_TYPE_READBACK
          ? D3D12_RESOURCE_STATE_COPY_DEST
          : D3D12_RESOURCE_STATE_COMMON;
    return this.createCommitted({ heapType, shape: bufferShape(sizeInBytes), resourceFlags: D3D12_RESOURCE_FLAG_NONE, initialState, label });
  }
}

/** Layout of a 2D texture when laid out linearly in a buffer, as D3D12 copies require. */
export function linearLayout(width: number, height: number, format: number): { rowBytes: number; rowPitch: number; totalBytes: number } {
  const rowBytes = width * bytesPerPixel(format);
  const rowPitch = align(rowBytes, D3D12_TEXTURE_DATA_PITCH_ALIGNMENT);
  return { rowBytes, rowPitch, totalBytes: align(rowPitch * height, D3D12_TEXTURE_DATA_PLACEMENT_ALIGNMENT) };
}

/** Copy tightly packed pixel rows into pitched buffer memory laid out by linearLayout. */
export function packRows(target: Uint8Array, pixels: Uint8Array, layout: { rowBytes: number; rowPitch: number }, height: number): void {
  if (layout.rowPitch === layout.rowBytes) {
    target.set(pixels);
    return;
  }
  for (let row = 0; row < height; row++) {
    target.set(pixels.subarray(row * layout.rowBytes, (row + 1) * layout.rowBytes), row * layout.rowPitch);
  }
}
