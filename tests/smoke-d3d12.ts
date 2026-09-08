/**
 * Manual smoke test: enumerate adapters, create a device on the NVIDIA GPU,
 * round-trip a synthetic RGBA8 frame through GPU memory and compare bytes.
 *
 *   bun run tests/smoke-d3d12.ts
 */
import { DxgiFactory, selectAdapter } from "../src/native/dxgi.ts";
import {
  D3D12Device,
  D3D12_RESOURCE_STATE_COPY_SOURCE,
  D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
  DXGI_FORMAT_R8G8B8A8_UNORM,
  GpuContext,
} from "../src/native/d3d12.ts";

const factory = DxgiFactory.create();
const adapters = factory.enumerate();
for (const adapter of adapters) {
  const i = adapter.info;
  console.log(`adapter ${i.index}: ${i.name} vendor=0x${i.vendorId.toString(16)} vram=${i.dedicatedVideoMemoryMB}MB luid=${i.luid}${i.software ? " (software)" : ""}`);
}
const chosen = selectAdapter(adapters);
if (!chosen) throw new Error("no NVIDIA adapter");
console.log(`using adapter ${chosen.info.index}`);

const device = D3D12Device.create(chosen, { debugLayer: process.argv.includes("--debug") });
console.log("device created");
const gpu = new GpuContext(device);

const width = 640;
const height = 360;
const pixels = new Uint8Array(width * height * 4);
for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + (i >> 9)) & 0xff;

const source = device.createTexture2D({ width, height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "source" });
const target = device.createTexture2D({ width, height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "target" });

const t0 = performance.now();
gpu.uploadTexture(source, pixels, D3D12_RESOURCE_STATE_COPY_SOURCE);
gpu.list.transition(target, 0x400);
gpu.list.copyResource(target, source);
const back = gpu.readbackTexture(target, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
const t1 = performance.now();

let mismatches = 0;
for (let i = 0; i < pixels.length; i++) if (pixels[i] !== back[i]) mismatches++;
console.log(`round trip ${width}x${height} RGBA8 in ${(t1 - t0).toFixed(1)} ms, mismatched bytes: ${mismatches}`);

let loops = 20;
const t2 = performance.now();
for (let n = 0; n < loops; n++) {
  gpu.uploadTexture(source, pixels, D3D12_RESOURCE_STATE_COPY_SOURCE);
  gpu.list.transition(target, 0x400);
  gpu.list.copyResource(target, source);
  gpu.readbackTexture(target, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
}
const t3 = performance.now();
console.log(`${loops} round trips: ${((t3 - t2) / loops).toFixed(2)} ms per frame`);

source.release();
target.release();
gpu.close();
device.release();
for (const adapter of adapters) adapter.release();
factory.release();
console.log(mismatches === 0 ? "OK" : "FAILED");
process.exit(mismatches === 0 ? 0 : 1);
