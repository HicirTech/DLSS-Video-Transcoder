/**
 * NVIDIA hardware Optical Flow (NVOFA) via the CUDA interface of nvofapi64.dll:
 * the flow session, its GPU buffers, and the FlowBackend (flow-backend.ts) that wraps them.
 *
 * ABI is from github.com/NVIDIA/NVIDIAOpticalFlowSDK (nvOpticalFlowCommon.h +
 * nvOpticalFlowCuda.h); API version 2.0. NV_OF_STATUS 0 = NV_OF_SUCCESS.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { callableAt, type OwnedCallable, type Signature } from "../native/com.ts";
import { cudaCreateContext, cudaMemcpy2DDtoH, cudaMemcpy2DHtoD, cudaReleaseContext, cudaSynchronize } from "../native/cuda.ts";
import { OutU64 } from "../native/memory.ts";
import type { OpticalFlowLimits } from "../server/api-types.ts";
import type { FlowBackend } from "./flow-backend.ts";
import { flowGridSize } from "./flow-grid.ts";

const NV_OF_API_VERSION = 0x20; // (major 2 << 4) | minor 0
const OK = 0;
/** NVOFA flow vectors are S10.5 fixed point: 5 fractional bits, so 32 steps per pixel. */
const FLOW_FRACTION_STEPS = 32;

/** NV_OF_CAPS enum values we query. */
const CAPS = { OUT_GRID: 0, WIDTH_MIN: 4, HEIGHT_MIN: 5, WIDTH_MAX: 6, HEIGHT_MAX: 7 } as const;

/** Index of each pointer in NV_OF_CUDA_API_FUNCTION_LIST (declaration order). */
const FN = {
  create: 0, init: 1, createBuf: 2, getArray: 3, getDevPtr: 4, getStride: 5,
  setStreams: 6, exec: 7, destroyBuf: 8, destroy: 9, lastError: 10, getCaps: 11,
} as const;

let fnList: bigint[] | null = null;

/**
 * Load the DLL and create the NVOFA CUDA instance on first use, caching its
 * function-pointer table. Loading here rather than at import lets the probe
 * (ngx/probe.ts, which imports this module) report a missing nvofapi64.dll as
 * an unavailable engine, and a video job fall back to the CPU matcher, instead
 * of failing at import.
 */
function functions(): bigint[] {
  if (fnList) return fnList;
  const lib = dlopen("nvofapi64.dll", {
    NvOFAPICreateInstanceCuda: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const buf = new BigUint64Array(12);
  const st = lib.symbols.NvOFAPICreateInstanceCuda(NV_OF_API_VERSION, buf) as number;
  if (st !== OK) throw new Error(`NvOFAPICreateInstanceCuda(0x${NV_OF_API_VERSION.toString(16)}) failed: NV_OF_STATUS ${st}`);
  fnList = Array.from(buf);
  if (fnList.some((p) => p === 0n)) throw new Error("NVOFA function list has null entries");
  return fnList;
}

function fn(index: number, sig: Signature): (...args: unknown[]) => unknown {
  return callableAt(Number(functions()[index]!), sig);
}

function ckof(status: unknown, what: string): void {
  if ((status as number) !== OK) throw new Error(`NVOFA ${what} failed: NV_OF_STATUS ${status}`);
}

/** Create an NVOFA instance on CUDA context `ctx` (nvCreateOpticalFlowCuda); the caller owns the handle until destroyInstance. */
function createInstance(ctx: bigint): bigint {
  const hOut = new OutU64();
  ckof(fn(FN.create, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(ctx, hOut.bytes), "nvCreateOpticalFlowCuda");
  return hOut.value;
}

function destroyInstance(hOf: bigint): void {
  fn(FN.destroy, { args: [FFIType.u64], returns: FFIType.i32 })(hOf);
}

/** What probeNvof learned about the engine; the probe report adds the CUDA ordinal on top (ProbeOpticalFlow). */
export type NvofCaps =
  | {
      status: "ok";
      detail: "ok";
      /** Input frame size the engine accepts. */
      limits: OpticalFlowLimits;
      /** Output grid sizes (one flow vector per NxN block) the engine offers. */
      outGridSizes: number[];
    }
  /** `detail` says why the engine could not be brought up. */
  | { status: "unavailable"; detail: string };

/**
 * Bring up NVOFA on CUDA device `ordinal` and read back its capabilities —
 * proves the whole CUDA + NVOFA FFI chain works without running a flow
 * computation. Never throws: a missing DLL, a device CUDA does not know or an
 * unsupported GPU comes back as status "unavailable" with the cause. A partial
 * answer (a limit the driver would not report) is "unavailable" too, so "ok"
 * always carries every number. Leaves the calling thread's CUDA context stack
 * as it found it (unless cudaReleaseContext itself fails, which is ignored):
 * runProbe (ngx/probe.ts) goes on to bring up NGX on the same thread.
 */
export function probeNvof(ordinal: number): NvofCaps {
  let pushed = false;
  try {
    const ctx = cudaCreateContext(ordinal);
    pushed = true;
    const hOf = createInstance(ctx);
    try {
      const getCaps = fn(FN.getCaps, { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
      // nvOFGetCaps is a two-call API: a NULL value buffer only reports the count.
      const cap = (param: number): number[] => {
        const size = new Uint32Array(1);
        let r = getCaps(hOf, param, null, ptr(size)) as number;
        if (r !== OK || size[0]! === 0) return [];
        const vals = new Uint32Array(size[0]!);
        r = getCaps(hOf, param, ptr(vals), ptr(size)) as number;
        return r === OK ? Array.from(vals) : [];
      };
      const limit = (name: string, param: number): number => {
        const value = cap(param)[0];
        if (value === undefined) throw new Error(`nvOFGetCaps reported no value for ${name}`);
        return value;
      };
      const limits: OpticalFlowLimits = {
        widthMin: limit("WIDTH_MIN", CAPS.WIDTH_MIN),
        widthMax: limit("WIDTH_MAX", CAPS.WIDTH_MAX),
        heightMin: limit("HEIGHT_MIN", CAPS.HEIGHT_MIN),
        heightMax: limit("HEIGHT_MAX", CAPS.HEIGHT_MAX),
      };
      const outGridSizes = cap(CAPS.OUT_GRID);
      if (outGridSizes.length === 0) throw new Error("nvOFGetCaps reported no output grid sizes");
      return { status: "ok", detail: "ok", limits, outGridSizes };
    } finally {
      destroyInstance(hOf);
    }
  } catch (error) {
    return { status: "unavailable", detail: (error as Error).message };
  } finally {
    if (pushed) {
      try {
        cudaReleaseContext(ordinal);
      } catch {
        // A failed release is ignored: the result is already decided and the probe cannot repair the stack.
      }
    }
  }
}

// -- Full flow session --------------------------------------------------------

const MODE_OPTICALFLOW = 1;
const PERF_MEDIUM = 10;
const FMT_GRAYSCALE8 = 1;
const FMT_SHORT2 = 5;
const USAGE_INPUT = 1;
const USAGE_OUTPUT = 2;
const CUDA_BUF_DEVPTR = 2;

interface NvofBuffer {
  handle: bigint;
  device: bigint;
  pitch: number;
}

/** NV_OF_INIT_PARAMS (48B) for a `width`x`height` session at one flow vector per pixel; offsets below name its fields. */
function initParams(width: number, height: number): Uint8Array {
  const params = new Uint8Array(48);
  const view = new DataView(params.buffer);
  view.setUint32(0, width, true); // width
  view.setUint32(4, height, true); // height
  view.setUint32(8, 1, true); // outGridSize = 1: one flow vector per input pixel
  view.setUint32(16, MODE_OPTICALFLOW, true); // mode
  view.setUint32(20, PERF_MEDIUM, true); // perfLevel
  return params;
}

/** What a session is built from once open() has brought every part up. */
interface SessionParts {
  hOf: bigint;
  width: number;
  height: number;
  buffers: { input: NvofBuffer; reference: NvofBuffer; output: NvofBuffer };
  calls: { execute: OwnedCallable; destroyBuf: OwnedCallable };
}

/**
 * A live NVOFA session, fixed at the width/height passed to open(): the input,
 * reference and output GPU buffers are allocated for that size and owned here
 * until close(). Feed a different resolution and you need a new session.
 */
class NvofSession {
  readonly width: number;
  readonly height: number;
  private readonly hOf: bigint;
  private readonly input: NvofBuffer;
  private readonly reference: NvofBuffer;
  private readonly output: NvofBuffer;
  private readonly execute: OwnedCallable;
  private readonly destroyBuf: OwnedCallable;

  private constructor({ hOf, width, height, buffers, calls }: SessionParts) {
    this.hOf = hOf;
    this.width = width;
    this.height = height;
    this.input = buffers.input;
    this.reference = buffers.reference;
    this.output = buffers.output;
    this.execute = calls.execute;
    this.destroyBuf = calls.destroyBuf;
  }

  static open(width: number, height: number, ordinal: number): NvofSession {
    const hOf = createInstance(cudaCreateContext(ordinal));

    // Everything past this point can throw, and until the session object exists
    // nothing else owns hOf or the buffers. The CUDA primary context is retained
    // for the life of the process, so a handle leaked here outlives the worker
    // that made it; `created` and the catch below give it back.
    const getDev = fn(FN.getDevPtr, { args: [FFIType.u64], returns: FFIType.u64 });
    const getStride = fn(FN.getStride, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 });
    const createBuf = fn(FN.createBuf, { args: [FFIType.u64, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 });
    const destroyBuf = fn(FN.destroyBuf, { args: [FFIType.u64], returns: FFIType.i32 });
    const created: bigint[] = [];

    try {
      ckof(fn(FN.init, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(hOf, initParams(width, height)), "nvOFInit");

      const mkBuf = (w: number, h: number, usage: number, format: number): NvofBuffer => {
        // NV_OF_BUFFER_DESCRIPTOR: width@0, height@4, bufferUsage@8, bufferFormat@12.
        const desc = new Uint8Array(16);
        const d = new DataView(desc.buffer);
        d.setUint32(0, w, true);
        d.setUint32(4, h, true);
        d.setUint32(8, usage, true);
        d.setUint32(12, format, true);
        const bOut = new OutU64();
        ckof(createBuf(hOf, desc, CUDA_BUF_DEVPTR, bOut.bytes), "nvOFCreateGPUBufferCuda");
        const handle = bOut.value;
        created.push(handle); // owned from here, before anything below can throw
        const device = getDev(handle) as bigint;
        // The driver picks the pitch; every copy below must use it, not w * bpp.
        const stride = new Uint8Array(28);
        ckof(getStride(handle, stride), "nvOFGPUBufferGetStrideInfo");
        const pitch = new DataView(stride.buffer).getUint32(0, true);
        return { handle, device, pitch };
      };

      const input = mkBuf(width, height, USAGE_INPUT, FMT_GRAYSCALE8);
      const reference = mkBuf(width, height, USAGE_INPUT, FMT_GRAYSCALE8);
      const output = mkBuf(width, height, USAGE_OUTPUT, FMT_SHORT2);

      return new NvofSession({
        hOf,
        width,
        height,
        buffers: { input, reference, output },
        calls: { execute: fn(FN.exec, { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }), destroyBuf },
      });
    } catch (error) {
      for (const handle of created.reverse()) try { destroyBuf(handle); } catch { /* best effort */ }
      try { destroyInstance(hOf); } catch { /* best effort */ }
      throw error;
    }
  }

  /**
   * Compute optical flow from `currentGray` to `previousGray` (GRAYSCALE8, tightly
   * packed width*height). Returns the raw flow field as interleaved int16 (x, y)
   * in S10.5 fixed point (divide by FLOW_FRACTION_STEPS for pixels), length
   * width*height*2. Synchronous: it blocks on cudaSynchronize before reading the
   * result back.
   */
  computeFlow(currentGray: Uint8Array, previousGray: Uint8Array, disableTemporalHints: boolean): Int16Array {
    const w = this.width;
    const h = this.height;
    cudaMemcpy2DHtoD({ src: currentGray, srcPitch: w, dstDevice: this.input.device, dstPitch: this.input.pitch, widthBytes: w, height: h });
    cudaMemcpy2DHtoD({ src: previousGray, srcPitch: w, dstDevice: this.reference.device, dstPitch: this.reference.pitch, widthBytes: w, height: h });

    // NV_OF_EXECUTE_INPUT_PARAMS: inputFrame@0, referenceFrame@8,
    // disableTemporalHints@24. With hints left on, the driver seeds from the
    // previous execute's vectors, which only helps if the calls really are
    // consecutive frames of one sequence; the backend turns them off at a
    // sequence start (FlowBackend.calc).
    const inParams = new Uint8Array(56);
    const iv = new DataView(inParams.buffer);
    iv.setBigUint64(0, this.input.handle, true);
    iv.setBigUint64(8, this.reference.handle, true);
    iv.setUint32(24, disableTemporalHints ? 1 : 0, true);
    // NV_OF_EXECUTE_OUTPUT_PARAMS: outputBuffer@0.
    const outParams = new Uint8Array(24);
    new DataView(outParams.buffer).setBigUint64(0, this.output.handle, true);
    ckof(this.execute(this.hOf, inParams, outParams), "nvOFExecute");
    cudaSynchronize();

    const host = new Uint8Array(w * h * 4);
    cudaMemcpy2DDtoH({ dst: host, dstPitch: w * 4, srcDevice: this.output.device, srcPitch: this.output.pitch, widthBytes: w * 4, height: h });
    return new Int16Array(host.buffer);
  }

  close(): void {
    // Best effort, one handle at a time so one failure cannot skip the rest. The
    // primary context lives for the whole process (see open()), so a handle the
    // driver refuses to free stays allocated until the process exits, not the worker.
    for (const handle of [this.input.handle, this.reference.handle, this.output.handle]) {
      try { this.destroyBuf(handle); } catch { /* best effort */ }
    }
    try { destroyInstance(this.hOf); } catch { /* best effort */ }
  }
}

function toByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
}

/**
 * Wrap an NVOFA session as a FlowBackend (flow-backend.ts): it receives the estimator's
 * downscaled Float32 grayscale grids, runs hardware optical flow, and returns the
 * grid-resolution (dx, dy) field in grid pixels (current -> previous, matching
 * the block-match sign convention).
 *
 * The two u8 scratch buffers are reused across calls, so one backend serves one
 * caller at a time — calc() must not be re-entered concurrently.
 */
function nvofBackend(session: NvofSession): FlowBackend {
  const n = session.width * session.height;
  const cur = new Uint8Array(n);
  const prev = new Uint8Array(n);
  return {
    calc: (current, previous, w, h, sequenceStart) => {
      if (w !== session.width || h !== session.height) {
        throw new Error(`nvof backend: expected ${session.width}x${session.height}, got ${w}x${h}`);
      }
      for (let i = 0; i < n; i++) {
        cur[i] = toByte(current[i]!);
        prev[i] = toByte(previous[i]!);
      }
      const raw = session.computeFlow(cur, prev, sequenceStart);
      const out = new Float32Array(n * 2);
      for (let i = 0; i < n * 2; i++) out[i] = raw[i]! / FLOW_FRACTION_STEPS;
      return out;
    },
    close: () => session.close(),
  };
}

/** A hardware backend, or the reason to show before falling back to the CPU matcher. */
export type NvofAttempt = { backend: FlowBackend; reason: null } | { backend: null; reason: string };

/**
 * Try to build an NVOFA optical-flow backend on CUDA device `ordinal` for
 * frames of `width`x`height` (sized to the estimator's flow grid). Failing is
 * not fatal — the CPU block matcher stands in, slower and coarser — but the
 * reason is returned rather than swallowed, so someone who asked for hardware
 * flow learns they lost it.
 */
export function tryCreateNvofBackend(width: number, height: number, ordinal: number): NvofAttempt {
  const { flowW, flowH } = flowGridSize(width, height);
  try {
    return { backend: nvofBackend(NvofSession.open(flowW, flowH, ordinal)), reason: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The pointer names the probe line that answers "does the engine come up on
    // this GPU"; its size limits never explain this failure, since the grid is
    // MIN_FLOW_SIDE..MAX_FLOW_LONG_SIDE (flow-grid.ts) px a side and every RTX reports a far wider range.
    return { backend: null, reason: `NVOFA hardware optical flow could not start on its ${flowW}x${flowH} grid, so this run uses the CPU block matcher instead -- slower and coarser (one whole-pixel motion vector per 8x8 grid block, at most 8 grid pixels each way), so the upscale can differ: ${detail}. Run \`probe\`: its "Hardware optical flow (NVOFA)" line says whether the engine comes up on the selected GPU and why not.` };
  }
}
