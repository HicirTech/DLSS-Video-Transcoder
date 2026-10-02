import { expect, test } from "bun:test";
import { FFIType, JSCallback, ptr, read, type Pointer } from "bun:ffi";
import {
  D3D12GraphicsCommandList,
  D3D12Resource,
  D3D12_RESOURCE_STATE_COPY_DEST,
  D3D12_RESOURCE_STATE_COPY_SOURCE,
  DXGI_FORMAT_R8G8B8A8_UNORM,
} from "../src/native/d3d12.ts";

// Stand-in resource addresses: the fake command list only compares them, nothing dereferences them.
const DESTINATION = 0x7ff612345000;
const SOURCE = 0x7ff612346000;
const FOOTPRINT = { offset: 512, format: DXGI_FORMAT_R8G8B8A8_UNORM, width: 1280, height: 720, rowPitch: 5120 };
// Copies and barriers are recorded for this long while garbage is allocated around them, so a collection can
// land between building a struct and the native read; every struct the fake list receives must be intact.
const RUN_MILLISECONDS = 2000;
const GARBAGE_ALLOCATIONS_PER_ROUND = 200;
const GARBAGE_KEPT = 64;

test("D3D12 command-list structs reach native code intact under allocation pressure", () => {
  const corrupted: string[] = [];
  let copies = 0;
  let barriers = 0;

  // ID3D12GraphicsCommandList::ResourceBarrier(NumBarriers, pBarriers), slot 26 (d3d12.h).
  const resourceBarrier = new JSCallback(
    (_list: Pointer, count: number, barrier: Pointer) => {
      barriers++;
      const resource = Number(read.ptr(barrier, 8));
      const before = read.u32(barrier, 20);
      const after = read.u32(barrier, 24);
      const swapsCopyStates =
        (before === D3D12_RESOURCE_STATE_COPY_DEST && after === D3D12_RESOURCE_STATE_COPY_SOURCE) ||
        (before === D3D12_RESOURCE_STATE_COPY_SOURCE && after === D3D12_RESOURCE_STATE_COPY_DEST);
      if (count !== 1 || read.u32(barrier, 0) !== 0 || (resource !== DESTINATION && resource !== SOURCE) || !swapsCopyStates) {
        corrupted.push(`barrier ${barriers}: resource 0x${resource.toString(16)}, ${before.toString(16)} -> ${after.toString(16)}`);
      }
    },
    { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.void },
  );
  // ID3D12GraphicsCommandList::CopyTextureRegion(pDst, DstX, DstY, DstZ, pSrc, pSrcBox), slot 16 (d3d12.h).
  const copyTextureRegion = new JSCallback(
    (_list: Pointer, destination: Pointer, _x: number, _y: number, _z: number, source: Pointer) => {
      copies++;
      const destinationResource = Number(read.ptr(destination, 0));
      const sourceResource = Number(read.ptr(source, 0));
      const footprintIntact =
        read.u32(source, 8) === 1 &&
        Number(read.u64(source, 16)) === FOOTPRINT.offset &&
        read.u32(source, 28) === FOOTPRINT.width &&
        read.u32(source, 32) === FOOTPRINT.height &&
        read.u32(source, 40) === FOOTPRINT.rowPitch;
      if (destinationResource !== DESTINATION || read.u32(destination, 8) !== 0 || sourceResource !== SOURCE || !footprintIntact) {
        corrupted.push(`copy ${copies}: destination 0x${destinationResource.toString(16)}, source 0x${sourceResource.toString(16)}`);
      }
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  );

  // A COM object is a pointer to its vtable. Both arrays are cleared in the finally below, which keeps
  // them referenced for as long as the list is driven.
  const vtable = new BigUint64Array(64);
  vtable[16] = BigInt(copyTextureRegion.ptr!);
  vtable[26] = BigInt(resourceBarrier.ptr!);
  const listObject = new BigUint64Array([BigInt(ptr(vtable))]);
  try {
    const list = new D3D12GraphicsCommandList(ptr(listObject), "fake command list");
    const destination = new D3D12Resource(DESTINATION, "destination", "texture2d", 1280, 720, DXGI_FORMAT_R8G8B8A8_UNORM, 0, D3D12_RESOURCE_STATE_COPY_DEST);
    const source = new D3D12Resource(SOURCE, "source", "texture2d", 1280, 720, DXGI_FORMAT_R8G8B8A8_UNORM, 0, D3D12_RESOURCE_STATE_COPY_DEST);

    const garbage: Uint8Array[] = [];
    const deadline = performance.now() + RUN_MILLISECONDS;
    while (performance.now() < deadline && corrupted.length === 0) {
      for (const resource of [destination, source]) {
        list.transition(resource, resource.state === D3D12_RESOURCE_STATE_COPY_DEST ? D3D12_RESOURCE_STATE_COPY_SOURCE : D3D12_RESOURCE_STATE_COPY_DEST);
      }
      list.copyTextureRegion({ resource: destination }, { resource: source, footprint: FOOTPRINT });
      // Short-lived buffers of the same size class as the structs, so a collected struct is reused quickly.
      for (let round = 0; round < GARBAGE_ALLOCATIONS_PER_ROUND; round++) {
        garbage[round % GARBAGE_KEPT] = new Uint8Array(32 + (round % 4) * 8);
      }
    }
    expect(copies).toBeGreaterThan(0);
    expect(corrupted).toEqual([]);
  } finally {
    listObject.fill(0n);
    vtable.fill(0n);
    resourceBarrier.close();
    copyTextureRegion.close();
  }
}, 30_000);
