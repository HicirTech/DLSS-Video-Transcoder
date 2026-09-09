/**
 * Asynchronous multi-buffered D3D12 submission for the zero-copy encode pipeline.
 *
 * The default GpuContext is synchronous: record on one list, submit, block until
 * the GPU finishes, repeat. That serializes DLSS against everything downstream.
 * AsyncSubmit keeps a small pool of command allocators/lists so the CPU can
 * record and submit frame i+1 while the GPU is still working on frame i, and
 * signals a SHARED fence with a monotonic value per submit — a CUDA worker,
 * having imported that fence as an external semaphore, waits on value i before
 * encoding frame i. DLSS (D3D12 compute) and NVENC (independent encoder units)
 * then overlap on the GPU (measured: near-perfect parallelism on the 5090).
 *
 * Resource-state tracking stays correct because a single queue executes lists in
 * submit order (FIFO), which matches the order the CPU records them in.
 */
import {
  D3D12CommandQueue, D3D12CommandAllocator, D3D12Fence, D3D12GraphicsCommandList, D3D12Device,
} from "./d3d12.ts";
import { Win32Event } from "./win32.ts";

export class AsyncSubmit {
  private readonly allocators: D3D12CommandAllocator[] = [];
  private readonly lists: D3D12GraphicsCommandList[] = [];
  private readonly slotValue: bigint[] = [];
  private readonly event = new Win32Event();
  private value = 0n;
  private closed = false;

  constructor(
    device: D3D12Device,
    private readonly queue: D3D12CommandQueue,
    private readonly fence: D3D12Fence,
    readonly depth: number,
  ) {
    for (let i = 0; i < depth; i++) {
      const allocator = device.createCommandAllocator();
      const list = device.createCommandList(allocator);
      list.close(); // created open; close so begin() can reset it
      this.allocators.push(allocator);
      this.lists.push(list);
      this.slotValue.push(0n);
    }
  }

  /** Wait until slot `k`'s previous submit is done on the GPU, then reset it and return its (open) list to record into. */
  begin(k: number, timeoutMs = 30_000): D3D12GraphicsCommandList {
    const want = this.slotValue[k]!;
    if (this.fence.completedValue() < want) {
      this.fence.setEventOnCompletion(want, this.event);
      if (!this.event.wait(timeoutMs)) throw new Error(`AsyncSubmit.begin(${k}): GPU did not reach fence ${want} within ${timeoutMs} ms`);
    }
    this.allocators[k]!.reset();
    this.lists[k]!.reset(this.allocators[k]!);
    return this.lists[k]!;
  }

  /** Close + execute slot `k`'s list and signal the shared fence with the next monotonic value; returns that value. */
  submit(k: number): bigint {
    const list = this.lists[k]!;
    list.close();
    this.queue.executeCommandList(list);
    this.value += 1n;
    this.queue.signal(this.fence, this.value);
    this.slotValue[k] = this.value;
    return this.value;
  }

  /** Block until every outstanding submit has completed on the GPU. */
  drain(timeoutMs = 30_000): void {
    if (this.fence.completedValue() < this.value) {
      this.fence.setEventOnCompletion(this.value, this.event);
      this.event.wait(timeoutMs);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.lists) l.release();
    for (const a of this.allocators) a.release();
    this.event.close();
  }
}
