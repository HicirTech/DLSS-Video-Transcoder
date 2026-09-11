/**
 * chooseGpu: the one rule for which adapter a job (openGpu) or the probe uses.
 * The fixture is this machine's DXGI table — five entries, three of them named
 * "RTX 5090" and only one backed by a CUDA device — in every rotation, because
 * DXGI's enumeration order is not stable between runs and the pick must not be.
 */
import { describe, expect, test } from "bun:test";
import type { AdapterInfo } from "../src/native/dxgi.ts";
import { selectAdapter } from "../src/native/dxgi.ts";
import { chooseGpu, type CudaSummary, type GpuCandidate } from "../src/pipeline/gpu.ts";

const RTX_LUID = "00000000-00018861";

function adapter(index: number, name: string, opts: { nvidia?: boolean; software?: boolean; vramMB?: number; luid?: string } = {}): AdapterInfo {
  const vramMB = opts.vramMB ?? 0;
  return {
    index,
    name,
    vendorId: opts.nvidia ? 0x10de : 0x1002,
    deviceId: 0,
    subSysId: 0,
    revision: 0,
    dedicatedVideoMemory: BigInt(vramMB) * 1048576n,
    dedicatedVideoMemoryMB: vramMB,
    luidLow: index,
    luidHigh: 0,
    luid: opts.luid ?? `00000000-0000000${index}`,
    flags: opts.software ? 2 : 0,
    software: opts.software ?? false,
    isNvidia: opts.nvidia ?? false,
  };
}

/** The development machine as DXGI listed it on 2026-09-11, with CUDA's answer per entry. */
const DEV_BOX: GpuCandidate[] = [
  { info: adapter(0, "AMD Radeon(TM) Graphics", { vramMB: 485, luid: "00000000-00019EF5" }), cudaOrdinal: null },
  { info: adapter(1, "NVIDIA GeForce RTX 5090", { nvidia: true, vramMB: 32187, luid: RTX_LUID }), cudaOrdinal: 0 },
  { info: adapter(2, "NVIDIA GeForce RTX 5090", { nvidia: true, vramMB: 32187, luid: "00000000-00026C40" }), cudaOrdinal: null },
  { info: adapter(3, "NVIDIA GeForce RTX 5090", { nvidia: true, vramMB: 32187, luid: "00000000-00025AF8" }), cudaOrdinal: null },
  { info: adapter(4, "Microsoft Basic Render Driver", { software: true, luid: "00000000-00019E7F" }), cudaOrdinal: null },
];
const ONE_DEVICE: CudaSummary = { deviceCount: 1, error: null };

/** Every rotation of the list, re-indexed the way DXGI would number a different enumeration order. */
function rotations(candidates: GpuCandidate[]): GpuCandidate[][] {
  return candidates.map((_, shift) =>
    [...candidates.slice(shift), ...candidates.slice(0, shift)].map((c, index) => ({ ...c, info: { ...c.info, index } })),
  );
}

describe("chooseGpu, auto", () => {
  test("picks the CUDA-backed RTX 5090 in every enumeration order", () => {
    for (const order of rotations(DEV_BOX)) {
      const choice = chooseGpu(order, ONE_DEVICE);
      const picked = order.find((c) => c.info.index === choice.index)!;
      expect(picked.info.luid).toBe(RTX_LUID);
      expect(choice.cudaOrdinal).toBe(0);
      expect(choice.reasons).toEqual([]);
    }
  });

  // The defect this replaces: selectAdapter alone follows enumeration order
  // across the three identical entries, so the same table picks different LUIDs.
  test("selectAdapter alone does not: the old rule lands on different LUIDs across orders", () => {
    const luids = new Set(rotations(DEV_BOX).map((order) => selectAdapter(order)!.info.luid));
    expect(luids.size).toBeGreaterThan(1);
  });

  test("a CUDA-backed NVIDIA adapter beats a larger CUDA-less one", () => {
    const candidates: GpuCandidate[] = [
      { info: adapter(0, "NVIDIA GeForce RTX 5090", { nvidia: true, vramMB: 32187 }), cudaOrdinal: null },
      { info: adapter(1, "NVIDIA GeForce RTX 4060", { nvidia: true, vramMB: 8188 }), cudaOrdinal: 0 },
    ];
    expect(chooseGpu(candidates, ONE_DEVICE)).toEqual({ index: 1, cudaOrdinal: 0, reasons: [] });
  });

  test("two CUDA-backed adapters with equal VRAM resolve to the lowest CUDA ordinal in either order", () => {
    const a: GpuCandidate = { info: adapter(0, "NVIDIA GeForce RTX 5090", { nvidia: true, vramMB: 32187, luid: "A" }), cudaOrdinal: 1 };
    const b: GpuCandidate = { info: adapter(1, "NVIDIA GeForce RTX 5090", { nvidia: true, vramMB: 32187, luid: "B" }), cudaOrdinal: 0 };
    expect(chooseGpu([a, b], { deviceCount: 2, error: null }).cudaOrdinal).toBe(0);
    expect(chooseGpu([b, a], { deviceCount: 2, error: null }).cudaOrdinal).toBe(0);
  });

  test("with no CUDA-backed NVIDIA adapter, the best NVIDIA one is named with the reason it is refused", () => {
    const candidates = DEV_BOX.map((c) => ({ ...c, cudaOrdinal: null }));
    const choice = chooseGpu(candidates, { deviceCount: 0, error: null });
    expect(choice.index).toBe(1);
    expect(choice.cudaOrdinal).toBeNull();
    expect(choice.reasons).toHaveLength(1);
    expect(choice.reasons[0]).toContain("has no CUDA device behind it");
    expect(choice.reasons[0]).toContain("CUDA lists no device.");
  });

  test("when CUDA could not be queried, the reason carries the driver error instead of blaming the adapter", () => {
    const candidates = DEV_BOX.map((c) => ({ ...c, cudaOrdinal: null }));
    const choice = chooseGpu(candidates, { deviceCount: null, error: "CUDA cuInit failed: NO_DEVICE (100)" });
    expect(choice.reasons[0]).toContain("CUDA could not be queried: CUDA cuInit failed: NO_DEVICE (100).");
  });

  test("no NVIDIA adapter at all names what is listed", () => {
    const choice = chooseGpu([DEV_BOX[0]!, DEV_BOX[4]!], ONE_DEVICE);
    expect(choice.index).toBeNull();
    expect(choice.reasons).toEqual(["No NVIDIA GPU was found; DLSS requires an NVIDIA RTX GPU. Available adapters: 0: AMD Radeon(TM) Graphics, 4: Microsoft Basic Render Driver."]);
  });
});

describe("chooseGpu, explicit index", () => {
  test("the CUDA-backed adapter is accepted without reasons", () => {
    expect(chooseGpu(DEV_BOX, ONE_DEVICE, 1)).toEqual({ index: 1, cudaOrdinal: 0, reasons: [] });
  });

  test("an NVIDIA duplicate without CUDA is refused with the LUID-tagged alternatives and the index caveat", () => {
    const choice = chooseGpu(DEV_BOX, ONE_DEVICE, 2);
    expect(choice.index).toBe(2);
    expect(choice.cudaOrdinal).toBeNull();
    expect(choice.reasons).toHaveLength(1);
    const reason = choice.reasons[0]!;
    expect(reason).toContain("Adapter 2 (NVIDIA GeForce RTX 5090, LUID 00000000-00026C40) has no CUDA device behind it");
    expect(reason).toContain("CUDA lists 1 device(s), none reporting this adapter's LUID 00000000-00026C40.");
    expect(reason).toContain(`Adapters with a CUDA device: 1: NVIDIA GeForce RTX 5090 (LUID ${RTX_LUID}, CUDA device 0).`);
    expect(reason).toContain("DXGI indices can change between runs; match by LUID.");
  });

  test("a non-NVIDIA adapter gets one reason, which names the adapters that qualify", () => {
    const choice = chooseGpu(DEV_BOX, ONE_DEVICE, 0);
    expect(choice.reasons).toEqual([
      `Adapter 0 (AMD Radeon(TM) Graphics) is not an NVIDIA GPU, and DLSS runs only on NVIDIA. Adapters with a CUDA device: 1: NVIDIA GeForce RTX 5090 (LUID ${RTX_LUID}, CUDA device 0).`,
    ]);
  });

  test("the software renderer is refused the same way, once", () => {
    const choice = chooseGpu(DEV_BOX, ONE_DEVICE, 4);
    expect(choice.reasons).toHaveLength(1);
    expect(choice.reasons[0]).toContain("Adapter 4 (Microsoft Basic Render Driver) is not an NVIDIA GPU");
  });

  test("an index that is not listed names the list", () => {
    const choice = chooseGpu(DEV_BOX, ONE_DEVICE, 9);
    expect(choice.index).toBeNull();
    expect(choice.reasons[0]).toStartWith("No adapter at index 9. Available adapters: 0: AMD Radeon(TM) Graphics, 1: NVIDIA GeForce RTX 5090 (LUID 00000000-00018861, CUDA device 0), 2: NVIDIA GeForce RTX 5090, ");
  });
});
