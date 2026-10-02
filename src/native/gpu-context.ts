/**
 * GpuContext: the synchronous record, submit and wait path between the CPU and
 * D3D12 resources, with the staging buffers uploads and readbacks go through.
 */
import { isFailure } from "./com.ts";
import {
  D3D12CommandAllocator,
  D3D12CommandQueue,
  D3D12Device,
  D3D12Fence,
  D3D12GraphicsCommandList,
  D3D12Resource,
  D3D12_HEAP_TYPE_READBACK,
  D3D12_HEAP_TYPE_UPLOAD,
  D3D12_RESOURCE_STATE_COPY_DEST,
  D3D12_RESOURCE_STATE_COPY_SOURCE,
  linearLayout,
} from "./d3d12.ts";
import { hex32, viewNative } from "./memory.ts";
import { Win32Event } from "./win32.ts";

interface BufferFill {
  buffers: readonly D3D12Resource[];
  /** The byte written to every position of every buffer, 0..255. */
  byteValue: number;
  /** State each buffer is left in for the rest of the open list. */
  finalState: number;
}

interface ReadbackRequest {
  textures: readonly D3D12Resource[];
  buffers: readonly D3D12Resource[];
  /**
   * State every texture is left in. Buffers need none: they are back in COMMON
   * once the submit completes (D3D12GraphicsCommandList.close).
   */
  textureRestoreState: number;
}

export interface Readback {
  /** Tightly packed rows of each texture, in request order. */
  textures: Uint8Array[];
  /** Every byte of each buffer, in request order. */
  buffers: Uint8Array[];
}

interface TextureSlot {
  offset: number;
  rowBytes: number;
  rowPitch: number;
  height: number;
}

interface ReadbackSlots {
  textures: TextureSlot[];
  buffers: { offset: number; byteCount: number }[];
  totalBytes: number;
}

/**
 * Where each resource lands in the one readback buffer. Textures go first:
 * every linearLayout().totalBytes is a multiple of the 512 B placement
 * alignment a footprint offset needs, so each texture slot stays aligned.
 * Buffers follow back to back.
 */
function readbackSlots(request: ReadbackRequest): ReadbackSlots {
  let offset = 0;
  const textures = request.textures.map((texture) => {
    const layout = linearLayout(texture.width, texture.height, texture.format);
    const slot = { offset, rowBytes: layout.rowBytes, rowPitch: layout.rowPitch, height: texture.height };
    offset += layout.totalBytes;
    return slot;
  });
  const buffers = request.buffers.map((buffer) => {
    const slot = { offset, byteCount: buffer.sizeInBytes };
    offset += buffer.sizeInBytes;
    return slot;
  });
  return { textures, buffers, totalBytes: offset };
}

/** Copy one texture's pitched rows out of mapped readback memory into a tightly packed array. */
function unpackRows(mapped: Uint8Array, slot: TextureSlot): Uint8Array {
  const out = new Uint8Array(slot.rowBytes * slot.height);
  if (slot.rowPitch === slot.rowBytes) {
    out.set(mapped.subarray(slot.offset, slot.offset + out.byteLength));
    return out;
  }
  for (let y = 0; y < slot.height; y++) {
    const rowStart = slot.offset + y * slot.rowPitch;
    out.set(mapped.subarray(rowStart, rowStart + slot.rowBytes), y * slot.rowBytes);
  }
  return out;
}

/**
 * One direct queue, one allocator, one command list and one fence: a simple
 * "record, submit, wait" context that the frame pipeline drives synchronously.
 */
export class GpuContext {
  readonly queue: D3D12CommandQueue;
  readonly allocator: D3D12CommandAllocator;
  readonly list: D3D12GraphicsCommandList;
  readonly fence: D3D12Fence;
  private readonly event = new Win32Event();
  private fenceValue = 0n;
  // A ring of upload staging buffers, one per uploadTexture or fillBuffers recorded
  // since the last submit, so several uploads batched before one submit do not alias.
  private readonly uploadRing: D3D12Resource[] = [];
  private uploadCursor = 0;
  private readbackBuffer: D3D12Resource | null = null;
  private closed = false;

  constructor(readonly device: D3D12Device) {
    this.queue = device.createCommandQueue();
    this.allocator = device.createCommandAllocator();
    this.list = device.createCommandList(this.allocator);
    this.fence = device.createFence();
  }

  /** Close the list, execute it, block until the GPU is done, and reopen the list. */
  submitAndWait(timeoutMs = 30_000): void {
    this.list.close();
    this.queue.executeCommandList(this.list);
    this.fenceValue += 1n;
    this.queue.signal(this.fence, this.fenceValue);
    if (this.fence.completedValue() < this.fenceValue) {
      this.fence.setEventOnCompletion(this.fenceValue, this.event);
      if (!this.event.wait(timeoutMs)) {
        const reason = this.device.deviceRemovedReason();
        throw new Error(`GPU did not finish within ${timeoutMs} ms (device removed reason ${hex32(reason)})`);
      }
    }
    const removed = this.device.deviceRemovedReason();
    if (isFailure(removed)) throw new Error(`D3D12 device removed: ${hex32(removed)}`);
    this.allocator.reset();
    this.list.reset(this.allocator);
    // The recorded copies have executed; staging buffers can be reused.
    this.uploadCursor = 0;
  }

  /**
   * False while the GPU still runs a submit whose wait timed out in submitAndWait. Until it
   * finishes, the list, the queue and every resource that submit uses must stay allocated.
   */
  get idle(): boolean {
    return this.fence.completedValue() >= this.fenceValue;
  }

  private ensureUpload(size: number): D3D12Resource {
    let buf = this.uploadRing[this.uploadCursor];
    if (!buf || buf.sizeInBytes < size) {
      buf?.release();
      buf = this.device.createBuffer(size, D3D12_HEAP_TYPE_UPLOAD, `upload staging ${this.uploadCursor}`);
      this.uploadRing[this.uploadCursor] = buf;
    }
    this.uploadCursor++;
    return buf;
  }

  private ensureReadback(size: number): D3D12Resource {
    if (!this.readbackBuffer || this.readbackBuffer.sizeInBytes < size) {
      this.readbackBuffer?.release();
      this.readbackBuffer = this.device.createBuffer(size, D3D12_HEAP_TYPE_READBACK, "readback staging");
    }
    return this.readbackBuffer;
  }

  /**
   * Copy tightly packed pixel rows into a texture (recorded on the open list;
   * the caller submits). The texture is left in `finalState`.
   */
  uploadTexture(texture: D3D12Resource, pixels: Uint8Array, finalState: number): void {
    const layout = linearLayout(texture.width, texture.height, texture.format);
    if (pixels.byteLength !== layout.rowBytes * texture.height) {
      throw new Error(`uploadTexture(${texture.label}): expected ${layout.rowBytes * texture.height} bytes, got ${pixels.byteLength}`);
    }
    const staging = this.ensureUpload(layout.totalBytes);
    const address = staging.map({ begin: 0, end: 0 });
    const target = viewNative(address, layout.totalBytes);
    if (layout.rowPitch === layout.rowBytes) {
      target.set(pixels);
    } else {
      for (let y = 0; y < texture.height; y++) {
        target.set(pixels.subarray(y * layout.rowBytes, (y + 1) * layout.rowBytes), y * layout.rowPitch);
      }
    }
    staging.unmap();
    this.list.transition(texture, D3D12_RESOURCE_STATE_COPY_DEST);
    this.list.copyTextureRegion(
      { resource: texture },
      { resource: staging, footprint: { offset: 0, format: texture.format, width: texture.width, height: texture.height, rowPitch: layout.rowPitch } },
    );
    this.list.transition(texture, finalState);
  }

  /**
   * Set every byte of each buffer to `byteValue` (recorded on the open list; the
   * caller submits). One staging slot serves all of them.
   */
  fillBuffers(fill: BufferFill): void {
    if (!Number.isInteger(fill.byteValue) || fill.byteValue < 0 || fill.byteValue > 0xff) {
      throw new Error(`fillBuffers: byteValue ${fill.byteValue} is not a byte; pass an integer from 0 to 255`);
    }
    if (fill.buffers.length === 0) return;
    const size = Math.max(...fill.buffers.map((buffer) => buffer.sizeInBytes));
    const staging = this.ensureUpload(size);
    viewNative(staging.map({ begin: 0, end: 0 }), size).fill(fill.byteValue);
    staging.unmap();
    for (const buffer of fill.buffers) {
      this.list.transition(buffer, D3D12_RESOURCE_STATE_COPY_DEST);
      this.list.copyBufferRegion({ resource: buffer, offset: 0 }, { resource: staging, offset: 0 }, buffer.sizeInBytes);
      this.list.transition(buffer, fill.finalState);
    }
  }

  /** Submit pending work, copy a texture back to the CPU and return tightly packed rows. */
  readbackTexture(texture: D3D12Resource, restoreState: number): Uint8Array {
    return this.readbackMany({ textures: [texture], buffers: [], textureRestoreState: restoreState }).textures[0]!;
  }

  /**
   * Submit pending work together with copies of every texture and buffer into
   * one readback buffer: one submit, one wait and one map, however many
   * resources are read.
   */
  readbackMany(request: ReadbackRequest): Readback {
    if (request.textures.length === 0 && request.buffers.length === 0) {
      throw new Error("readbackMany: no textures or buffers requested; pass at least one resource to read back");
    }
    const slots = readbackSlots(request);
    const staging = this.ensureReadback(slots.totalBytes);
    this.recordReadbackCopies(request, slots, staging);
    this.submitAndWait();
    const mapped = viewNative(staging.map(null), slots.totalBytes);
    try {
      return {
        textures: slots.textures.map((slot) => unpackRows(mapped, slot)),
        buffers: slots.buffers.map((slot) => mapped.slice(slot.offset, slot.offset + slot.byteCount)),
      };
    } finally {
      staging.unmap({ begin: 0, end: 0 });
    }
  }

  private recordReadbackCopies(request: ReadbackRequest, slots: ReadbackSlots, staging: D3D12Resource): void {
    request.textures.forEach((texture, index) => {
      const slot = slots.textures[index]!;
      this.list.transition(texture, D3D12_RESOURCE_STATE_COPY_SOURCE);
      this.list.copyTextureRegion(
        { resource: staging, footprint: { offset: slot.offset, format: texture.format, width: texture.width, height: texture.height, rowPitch: slot.rowPitch } },
        { resource: texture },
      );
      this.list.transition(texture, request.textureRestoreState);
    });
    request.buffers.forEach((buffer, index) => {
      const slot = slots.buffers[index]!;
      this.list.transition(buffer, D3D12_RESOURCE_STATE_COPY_SOURCE);
      this.list.copyBufferRegion({ resource: staging, offset: slot.offset }, { resource: buffer, offset: 0 }, slot.byteCount);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const b of this.uploadRing) b.release();
    this.readbackBuffer?.release();
    this.list.release();
    this.allocator.release();
    this.fence.release();
    this.queue.release();
    this.event.close();
  }
}
