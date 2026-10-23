/**
 * Multi-buffered D3D12 submission: a pool of `depth` allocators/lists so the CPU
 * can record and submit frame i+1 while the GPU still works on frame i.
 *
 * Every submit signals a SHARED fence with the next monotonic value. A CUDA
 * worker that imported that fence as an external semaphore waits on value i
 * before encoding frame i, which is what lets DLSS (D3D12 compute) and NVENC
 * (separate encoder units) run concurrently instead of in lockstep.
 *
 * D3D12Resource.state tracking stays correct only because one queue executes
 * lists in submit order, which is the order the CPU recorded them in.
 */
import {
  D3D12CommandQueue, D3D12CommandAllocator, D3D12Fence, D3D12GraphicsCommandList, D3D12Device, FENCE_WAIT_TIMEOUT_MS, gpuTimeoutError,
} from "./d3d12.ts";
import { Win32Event } from "./win32.ts";

export interface AsyncSubmitOptions {
  device: D3D12Device;
  queue: D3D12CommandQueue;
  /** Signalled with the next value by every submit; a consumer that imported it waits on those values. */
  fence: D3D12Fence;
  /** How many lists can be in flight at once. */
  depth: number;
}

export class AsyncSubmit {
  readonly depth: number;
  private readonly device: D3D12Device;
  private readonly queue: D3D12CommandQueue;
  private readonly fence: D3D12Fence;
  private readonly allocators: D3D12CommandAllocator[] = [];
  private readonly lists: D3D12GraphicsCommandList[] = [];
  private readonly slotValue: bigint[] = [];
  private readonly event = new Win32Event();
  private value = 0n;
  private closed = false;

  constructor(options: AsyncSubmitOptions) {
    this.device = options.device;
    this.queue = options.queue;
    this.fence = options.fence;
    this.depth = options.depth;
    try {
      for (let slot = 0; slot < this.depth; slot++) {
        const allocator = this.device.createCommandAllocator();
        this.allocators.push(allocator);
        const list = this.device.createCommandList(allocator);
        this.lists.push(list);
        list.close(); // D3D12 hands back an open list; begin() expects to reset it
        this.slotValue.push(0n);
      }
    } catch (error) {
      // Nothing owns a partly built pool yet, so the slots created so far and the event are released here.
      this.close();
      throw error;
    }
  }

  /** Wait for `slot`'s previous submit to finish on the GPU before reusing its allocator; returns the reset, open list. */
  begin(slot: number, timeoutMs = FENCE_WAIT_TIMEOUT_MS): D3D12GraphicsCommandList {
    this.waitFor(this.slotValue[slot]!, `AsyncSubmit.begin(${slot})`, timeoutMs);
    this.allocators[slot]!.reset();
    this.lists[slot]!.reset(this.allocators[slot]!);
    return this.lists[slot]!;
  }

  /** Execute slot `k`'s list; returns the fence value the GPU will reach once that list has retired. */
  submit(k: number): bigint {
    const list = this.lists[k]!;
    list.close();
    this.queue.executeCommandList(list);
    this.value += 1n;
    this.queue.signal(this.fence, this.value);
    this.slotValue[k] = this.value;
    return this.value;
  }

  /** Block until every outstanding submit has completed on the GPU; throws when that takes longer than `timeoutMs`. */
  drain(timeoutMs = FENCE_WAIT_TIMEOUT_MS): void {
    this.waitFor(this.value, "AsyncSubmit.drain", timeoutMs);
  }

  /**
   * False while the GPU still runs a submit that drain timed out on. Until it finishes, the lists, the allocators
   * and every resource the submits use must stay allocated.
   */
  get idle(): boolean {
    return this.fence.completedValue() >= this.value;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.lists) l.release();
    for (const a of this.allocators) a.release();
    this.event.close();
  }

  private waitFor(value: bigint, what: string, timeoutMs: number): void {
    if (!this.fence.waitFor(value, this.event, timeoutMs)) throw this.device.removedError(what) ?? gpuTimeoutError(what, timeoutMs);
  }
}
