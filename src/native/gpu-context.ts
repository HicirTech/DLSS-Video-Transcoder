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
  // A ring of upload staging buffers, one per uploadTexture recorded since the
  // last submit, so several uploads batched before one submit do not alias.
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

  /** Submit pending work, copy a texture back to the CPU and return tightly packed rows. */
  readbackTexture(texture: D3D12Resource, restoreState: number): Uint8Array {
    const layout = linearLayout(texture.width, texture.height, texture.format);
    const staging = this.ensureReadback(layout.totalBytes);
    this.list.transition(texture, D3D12_RESOURCE_STATE_COPY_SOURCE);
    this.list.copyTextureRegion(
      { resource: staging, footprint: { offset: 0, format: texture.format, width: texture.width, height: texture.height, rowPitch: layout.rowPitch } },
      { resource: texture },
    );
    this.list.transition(texture, restoreState);
    this.submitAndWait();
    const address = staging.map(null);
    const source = viewNative(address, layout.totalBytes);
    const out = new Uint8Array(layout.rowBytes * texture.height);
    if (layout.rowPitch === layout.rowBytes) {
      out.set(source.subarray(0, out.byteLength));
    } else {
      for (let y = 0; y < texture.height; y++) {
        out.set(source.subarray(y * layout.rowPitch, y * layout.rowPitch + layout.rowBytes), y * layout.rowBytes);
      }
    }
    staging.unmap({ begin: 0, end: 0 });
    return out;
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
