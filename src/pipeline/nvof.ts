/**
 * NVIDIA hardware Optical Flow (NVOFA) via the CUDA interface of nvofapi64.dll.
 *
 * Turing+ GPUs have a dedicated optical-flow engine, independent of the CUDA and
 * graphics cores, that computes dense flow between two frames far faster than the
 * CPU block-matcher in flow.ts. This module drives it through the CUDA API
 * (nvOpticalFlowCuda.h): create an instance (which fills a function-pointer
 * table), create the OF session on a CUDA context, allocate NVOFA GPU buffers,
 * upload two frames, execute, and read back the flow field (S10.5 fixed point).
 *
 * ABI is from github.com/NVIDIA/NVIDIAOpticalFlowSDK (nvOpticalFlowCommon.h +
 * nvOpticalFlowCuda.h); API version 2.0. NV_OF_STATUS 0 = NV_OF_SUCCESS.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { callableAt, type Signature } from "../native/com.ts";
import { cudaCreateContext } from "../native/cuda.ts";
import { OutU64 } from "../native/memory.ts";

const NV_OF_API_VERSION = 0x20; // (major 2 << 4) | minor 0
const OK = 0;

/** NV_OF_CAPS enum values we query. */
const CAPS = { OUT_GRID: 0, HINT_GRID: 1, WIDTH_MIN: 4, HEIGHT_MIN: 5, WIDTH_MAX: 6, HEIGHT_MAX: 7 } as const;

/** Index of each pointer in NV_OF_CUDA_API_FUNCTION_LIST (declaration order). */
const FN = {
  create: 0, init: 1, createBuf: 2, getArray: 3, getDevPtr: 4, getStride: 5,
  setStreams: 6, exec: 7, destroyBuf: 8, destroy: 9, lastError: 10, getCaps: 11,
} as const;

const lib = dlopen("nvofapi64.dll", {
  NvOFAPICreateInstanceCuda: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
});

let fnList: bigint[] | null = null;

/** Create the NVOFA CUDA instance once and cache its function-pointer table. */
function functions(): bigint[] {
  if (fnList) return fnList;
  const buf = new BigUint64Array(12);
  const st = lib.symbols.NvOFAPICreateInstanceCuda(NV_OF_API_VERSION, ptr(buf)) as number;
  if (st !== OK) throw new Error(`NvOFAPICreateInstanceCuda(0x${NV_OF_API_VERSION.toString(16)}) failed: NV_OF_STATUS ${st}`);
  fnList = Array.from(buf);
  if (fnList.some((p) => p === 0n)) throw new Error("NVOFA function list has null entries");
  return fnList;
}

function fn(index: number, sig: Signature): (...args: unknown[]) => unknown {
  return callableAt(Number(functions()[index]!), sig);
}

export interface NvofCaps {
  available: boolean;
  detail: string;
  widthMin?: number;
  widthMax?: number;
  heightMin?: number;
  heightMax?: number;
  outGridSizes?: number[];
}

/**
 * Bring up NVOFA on GPU `ordinal` and read back its capabilities — proves the
 * whole CUDA + NVOFA FFI chain works without running a full flow computation.
 */
export function probeNvof(ordinal = 0): NvofCaps {
  try {
    const ctx = cudaCreateContext(ordinal);
    const create = fn(FN.create, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 });
    const hOut = new OutU64();
    const st = create(ctx, hOut.ptr) as number;
    if (st !== OK) return { available: false, detail: `nvCreateOpticalFlowCuda failed: NV_OF_STATUS ${st}` };
    const hOf = hOut.value;

    const getCaps = fn(FN.getCaps, { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
    const cap = (param: number): number[] => {
      const size = new Uint32Array(1);
      let r = getCaps(hOf, param, null, ptr(size)) as number;
      if (r !== OK || size[0]! === 0) return [];
      const vals = new Uint32Array(size[0]!);
      r = getCaps(hOf, param, ptr(vals), ptr(size)) as number;
      return r === OK ? Array.from(vals) : [];
    };

    const widthMin = cap(CAPS.WIDTH_MIN)[0];
    const widthMax = cap(CAPS.WIDTH_MAX)[0];
    const heightMin = cap(CAPS.HEIGHT_MIN)[0];
    const heightMax = cap(CAPS.HEIGHT_MAX)[0];
    const outGridSizes = cap(CAPS.OUT_GRID);

    fn(FN.destroy, { args: [FFIType.u64], returns: FFIType.i32 })(hOf);
    return { available: true, detail: "ok", widthMin, widthMax, heightMin, heightMax, outGridSizes };
  } catch (error) {
    return { available: false, detail: (error as Error).message };
  }
}
