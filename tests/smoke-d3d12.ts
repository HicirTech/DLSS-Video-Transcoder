/**
 * Manual smoke test: enumerate adapters, create a device on the NVIDIA GPU,
 * round-trip synthetic textures and buffers through GPU memory and compare bytes.
 *
 *   bun run tests/smoke-d3d12.ts
 */
import { DxgiFactory, selectAdapter } from "../src/native/dxgi.ts";
import {
  D3D12Device,
  D3D12Resource,
  D3D12_RESOURCE_STATE_COMMON,
  D3D12_RESOURCE_STATE_COPY_DEST,
  D3D12_RESOURCE_STATE_COPY_SOURCE,
  D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
  DXGI_FORMAT_R16G16_FLOAT,
  DXGI_FORMAT_R32_FLOAT,
  DXGI_FORMAT_R8G8B8A8_UNORM,
  bytesPerPixel,
  formatName,
} from "../src/native/d3d12.ts";
import { GpuContext } from "../src/native/gpu-context.ts";
import { DISABLE_FLAG_BUFFER_BYTES, DISABLE_FLAG_UNWRITTEN } from "../src/ngx/dlssg-interval.ts";

const UAV = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
// The DLSS-G disable-flag pre-fill alternated with the 0 the runtime writes, so each fill has to overwrite what the previous one left.
const FILL_PATTERNS = [DISABLE_FLAG_UNWRITTEN, 0x00, DISABLE_FLAG_UNWRITTEN];

interface TextureShape {
  width: number;
  height: number;
  format: number;
}

// Row pitch equal to the row size, and two where each row is padded to the 256 B pitch alignment.
const READBACK_SHAPES: TextureShape[] = [
  { width: 640, height: 360, format: DXGI_FORMAT_R8G8B8A8_UNORM },
  { width: 333, height: 77, format: DXGI_FORMAT_R8G8B8A8_UNORM },
  { width: 100, height: 50, format: DXGI_FORMAT_R32_FLOAT },
];

const failures: string[] = [];
const resources: D3D12Resource[] = [];

function check(what: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

function countMismatches(expected: Uint8Array, actual: Uint8Array): number {
  if (expected.byteLength !== actual.byteLength) return Math.max(expected.byteLength, actual.byteLength);
  let mismatches = 0;
  for (let i = 0; i < expected.byteLength; i++) if (expected[i] !== actual[i]) mismatches++;
  return mismatches;
}

/** xorshift32, so a failing upload can be reproduced from its printed seed. */
function randomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

function tracked<T extends D3D12Resource>(resource: T): T {
  resources.push(resource);
  return resource;
}

function describeShape(shape: TextureShape): string {
  return `${shape.width}x${shape.height} ${formatName(shape.format)}`;
}

function uploadRandom(gpu: GpuContext, device: D3D12Device, shape: TextureShape, seed: number): { texture: D3D12Resource; pixels: Uint8Array } {
  const texture = tracked(device.createTexture2D({ ...shape, allowUnorderedAccess: true, label: `random ${describeShape(shape)}` }));
  const pixels = randomBytes(shape.width * shape.height * bytesPerPixel(shape.format), seed);
  gpu.uploadTexture(texture, pixels, UAV);
  return { texture, pixels };
}

function checkRoundTrip(gpu: GpuContext, device: D3D12Device): void {
  const width = 640;
  const height = 360;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + (i >> 9)) & 0xff;
  const source = tracked(device.createTexture2D({ width, height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "source" }));
  const target = tracked(device.createTexture2D({ width, height, format: DXGI_FORMAT_R8G8B8A8_UNORM, allowUnorderedAccess: true, label: "target" }));
  const recordCopy = (): void => {
    gpu.uploadTexture(source, pixels, D3D12_RESOURCE_STATE_COPY_SOURCE);
    gpu.list.transition(target, D3D12_RESOURCE_STATE_COPY_DEST);
    gpu.list.copyResource(target, source);
  };
  const started = performance.now();
  recordCopy();
  const back = gpu.readbackTexture(target, UAV);
  const mismatches = countMismatches(pixels, back);
  check(`round trip ${width}x${height} RGBA8 in ${(performance.now() - started).toFixed(1)} ms, mismatched bytes: ${mismatches}`, mismatches === 0);
  const loops = 20;
  const loopStart = performance.now();
  for (let n = 0; n < loops; n++) {
    recordCopy();
    gpu.readbackTexture(target, UAV);
  }
  console.log(`${loops} round trips: ${((performance.now() - loopStart) / loops).toFixed(2)} ms per frame`);
}

function checkReadbackMatchesUpload(gpu: GpuContext, device: D3D12Device): void {
  READBACK_SHAPES.forEach((shape, index) => {
    const seed = 0x5eed0000 + index;
    const { texture, pixels } = uploadRandom(gpu, device, shape, seed);
    const mismatches = countMismatches(pixels, gpu.readbackTexture(texture, UAV));
    check(`readbackTexture(t) == upload, ${describeShape(shape)} seed ${seed.toString(16)}: ${mismatches} mismatched bytes`, mismatches === 0);
  });
}

function throws(action: () => void): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

function checkBufferFill(gpu: GpuContext, device: D3D12Device): void {
  const buffers = Array.from({ length: 3 }, (_, index) => tracked(device.createUnorderedAccessBuffer(DISABLE_FLAG_BUFFER_BYTES, `fill ${index}`)));
  for (const byteValue of FILL_PATTERNS) {
    gpu.fillBuffers({ buffers, byteValue, finalState: UAV });
    const back = gpu.readbackMany({ textures: [], buffers, textureRestoreState: UAV }).buffers;
    const wrong = back.reduce((sum, bytes) => sum + (bytes.byteLength === DISABLE_FLAG_BUFFER_BYTES ? bytes.filter((byte) => byte !== byteValue).length : DISABLE_FLAG_BUFFER_BYTES), 0);
    check(`fill ${buffers.length} x ${DISABLE_FLAG_BUFFER_BYTES} B UAV buffers with 0x${byteValue.toString(16)}: ${wrong} wrong bytes`, wrong === 0);
  }
  check("buffers are tracked as COMMON once the submit completes", buffers.every((buffer) => buffer.state === D3D12_RESOURCE_STATE_COMMON));
  check("fillBuffers rejects a byteValue outside 0..255", throws(() => gpu.fillBuffers({ buffers, byteValue: 0x1cd, finalState: UAV })));
  check("readbackMany rejects an empty request", throws(() => gpu.readbackMany({ textures: [], buffers: [], textureRestoreState: UAV })));
}

function checkBatch(gpu: GpuContext, device: D3D12Device): void {
  const shapes: TextureShape[] = [
    { width: 333, height: 77, format: DXGI_FORMAT_R8G8B8A8_UNORM },
    { width: 333, height: 77, format: DXGI_FORMAT_R8G8B8A8_UNORM },
    { width: 1280, height: 720, format: DXGI_FORMAT_R16G16_FLOAT },
    { width: 100, height: 50, format: DXGI_FORMAT_R32_FLOAT },
  ];
  const uploads = shapes.map((shape, index) => uploadRandom(gpu, device, shape, 0xba7c0000 + index));
  // A 100 B buffer first puts every later buffer copy at an offset that is not a multiple of 256.
  const buffers = [tracked(device.createUnorderedAccessBuffer(100, "odd-size buffer"))];
  for (let index = 0; index < 4; index++) buffers.push(tracked(device.createUnorderedAccessBuffer(DISABLE_FLAG_BUFFER_BYTES, `batch buffer ${index}`)));
  const fillValues = buffers.map((_, index) => 0x10 + index);
  buffers.forEach((buffer, index) => gpu.fillBuffers({ buffers: [buffer], byteValue: fillValues[index]!, finalState: UAV }));
  const started = performance.now();
  const back = gpu.readbackMany({ textures: uploads.map((upload) => upload.texture), buffers, textureRestoreState: UAV });
  const elapsed = performance.now() - started;
  const textureMismatches = uploads.map((upload, index) => countMismatches(upload.pixels, back.textures[index]!));
  const bufferMismatches = buffers.map((buffer, index) => countMismatches(new Uint8Array(buffer.sizeInBytes).fill(fillValues[index]!), back.buffers[index]!));
  check(`batch of ${shapes.length} textures + ${buffers.length} buffers in one submit (${elapsed.toFixed(1)} ms): texture mismatches [${textureMismatches}], buffer mismatches [${bufferMismatches}]`, [...textureMismatches, ...bufferMismatches].every((count) => count === 0));
}

const factory = DxgiFactory.create();
const adapters = factory.enumerate();
let device: D3D12Device | null = null;
let gpu: GpuContext | null = null;
try {
  for (const adapter of adapters) {
    const i = adapter.info;
    console.log(`adapter ${i.index}: ${i.name} vendor=0x${i.vendorId.toString(16)} vram=${i.dedicatedVideoMemoryMB}MB luid=${i.luid}${i.software ? " (software)" : ""}`);
  }
  const chosen = selectAdapter(adapters);
  if (!chosen) throw new Error("no NVIDIA adapter");
  console.log(`using adapter ${chosen.info.index}`);
  device = D3D12Device.create(chosen, { debugLayer: process.argv.includes("--debug") });
  console.log("device created");
  gpu = new GpuContext(device);
  checkRoundTrip(gpu, device);
  checkReadbackMatchesUpload(gpu, device);
  checkBufferFill(gpu, device);
  checkBatch(gpu, device);
} finally {
  for (const resource of resources) resource.release();
  gpu?.close();
  device?.release();
  for (const adapter of adapters) adapter.release();
  factory.release();
}
console.log(failures.length === 0 ? "OK" : `FAILED: ${failures.length} check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
