/**
 * Who releases the D3D12 objects of GpuContext and AsyncSubmit (src/native): a half-built one undoes itself, and a
 * submit whose wait timed out keeps every object it may still use. Stand-in device objects record their releases.
 */
import { describe, expect, test } from "bun:test";
import { AsyncSubmit } from "../src/native/async-submit.ts";
import type { D3D12CommandQueue, D3D12Device, D3D12Fence } from "../src/native/d3d12.ts";
import { GpuContext } from "../src/native/gpu-context.ts";

/** A D3D12 object stand-in that counts its releases. */
class FakeObject {
  releases = 0;
  constructor(readonly name: string) {}
  release(): void {
    this.releases++;
  }
  close(): void {}
  reset(): void {}
}

/** A fence that reaches a signalled value only when `completes` is set, as a GPU that may hang would. */
class FakeFence extends FakeObject {
  completed = 0n;
  completes = true;
  completedValue(): bigint {
    return this.completed;
  }
  waitFor(value: bigint): boolean {
    return this.completed >= value;
  }
}

class FakeQueue extends FakeObject {
  constructor(private readonly fence: FakeFence) {
    super("queue");
  }
  executeCommandList(): void {}
  signal(_fence: unknown, value: bigint): void {
    if (this.fence.completes) this.fence.completed = value;
  }
}

/** A device whose `failAt`-th create call throws; everything it hands out is kept in `created`. */
function fakeDevice(fence: FakeFence, failAt = Number.POSITIVE_INFINITY) {
  const created: FakeObject[] = [];
  let calls = 0;
  const make = <T extends FakeObject>(object: T): T => {
    if (++calls === failAt) throw new Error(`create ${object.name} failed`);
    created.push(object);
    return object;
  };
  const device = {
    createCommandQueue: () => make(new FakeQueue(fence)),
    createCommandAllocator: () => make(new FakeObject("allocator")),
    createCommandList: () => make(new FakeObject("list")),
    createFence: () => make(fence),
    removedError: () => null,
  };
  return { device: device as unknown as D3D12Device, created };
}

describe("GpuContext", () => {
  test("a context whose fence cannot be created releases the queue, allocator and list it made", () => {
    const { device, created } = fakeDevice(new FakeFence("fence"), 4);
    expect(() => new GpuContext(device)).toThrow("create fence failed");
    expect(created.map((object) => [object.name, object.releases])).toEqual([["queue", 1], ["allocator", 1], ["list", 1]]);
  });

  test("a context still running a submit whose wait timed out keeps its objects when closed", () => {
    const fence = new FakeFence("fence");
    fence.completes = false;
    const { device, created } = fakeDevice(fence);
    const context = new GpuContext(device);
    expect(() => context.submitAndWait(0)).toThrow("the GPU did not finish within 0 ms");
    expect(context.idle).toBe(false);

    context.close();

    expect(created.every((object) => object.releases === 0)).toBe(true);
  });

  test("an idle context releases its objects when closed", () => {
    const { device, created } = fakeDevice(new FakeFence("fence"));
    const context = new GpuContext(device);
    context.submitAndWait();

    context.close();

    expect(created.map((object) => [object.name, object.releases])).toEqual([["queue", 1], ["allocator", 1], ["list", 1], ["fence", 1]]);
  });
});

describe("AsyncSubmit", () => {
  test("a pool whose second list cannot be created releases the slot it made", () => {
    const fence = new FakeFence("fence");
    const { device, created } = fakeDevice(fence, 4);
    const queue = new FakeQueue(fence) as unknown as D3D12CommandQueue;
    expect(() => new AsyncSubmit({ device, queue, fence: fence as unknown as D3D12Fence, depth: 2 })).toThrow("create list failed");
    expect(created.map((object) => [object.name, object.releases])).toEqual([["allocator", 1], ["list", 1], ["allocator", 1]]);
  });

  test("drain throws when the GPU does not reach the last fence value in time, and the pool reads busy", () => {
    const fence = new FakeFence("fence");
    fence.completes = false;
    const { device } = fakeDevice(fence);
    const submit = new AsyncSubmit({ device, queue: new FakeQueue(fence) as unknown as D3D12CommandQueue, fence: fence as unknown as D3D12Fence, depth: 1 });
    submit.begin(0);
    submit.submit(0);

    expect(() => submit.drain(0)).toThrow("AsyncSubmit.drain: the GPU did not finish within 0 ms");
    expect(submit.idle).toBe(false);
  });
});
