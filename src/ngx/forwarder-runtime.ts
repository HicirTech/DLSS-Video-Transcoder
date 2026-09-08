/**
 * Load the generated nvngx.dll shim and expose its exports as typed calls.
 * Also provides a self-test that proves the call path works without touching
 * NVIDIA code: the slots are pointed at JavaScript callbacks and the stubs are
 * driven with sentinel arguments.
 */
import { FFIType, JSCallback } from "bun:ffi";
import { callableAt } from "../native/com.ts";
import { asPtr } from "../native/memory.ts";
import { LOAD_WITH_ALTERED_SEARCH_PATH, NativeModule } from "../native/win32.ts";
import { FORWARDER_EXPORTS, writeForwarder } from "./forwarder.ts";

export interface ForwarderModule {
  readonly path: string;
  readonly module: NativeModule;
  /** Address of each export, for diagnostics. */
  readonly addresses: Record<(typeof FORWARDER_EXPORTS)[number], number>;
  setSlots(create: number, evaluate: number, release: number): void;
  create(cmdList: number, featureId: number, params: number, outHandle: number): number;
  evaluate(cmdList: number, handle: number, params: number, callback: number): number;
  release(handle: number): number;
}

export function loadForwarder(path: string): ForwarderModule {
  const module = NativeModule.load(path, LOAD_WITH_ALTERED_SEARCH_PATH);
  const addresses = {} as Record<(typeof FORWARDER_EXPORTS)[number], number>;
  for (const name of FORWARDER_EXPORTS) addresses[name] = module.requireProc(name);

  const setSlots = callableAt(addresses.fwd_set_slots, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void });
  const create = callableAt(addresses.fwd_create, { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
  const evaluate = callableAt(addresses.fwd_evaluate, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
  const release = callableAt(addresses.fwd_release, { args: [FFIType.ptr], returns: FFIType.i32 });

  const nz = (p: number) => (p === 0 ? null : p);
  return {
    path,
    module,
    addresses,
    setSlots: (c, e, r) => {
      setSlots(nz(c), nz(e), nz(r));
    },
    create: (cmdList, featureId, params, outHandle) => create(nz(cmdList), featureId, nz(params), nz(outHandle)) as number,
    evaluate: (cmdList, handle, params, callback) => evaluate(nz(cmdList), nz(handle), nz(params), nz(callback)) as number,
    release: (handle) => release(nz(handle)) as number,
  };
}

/** Generate the shim under `dir` (as `nvngx.dll`) and load it. */
export async function prepareForwarder(dir: string): Promise<{ forwarder: ForwarderModule; wrote: boolean }> {
  const path = `${dir.replace(/[\\/]+$/, "")}\\nvngx.dll`;
  const { wrote } = await writeForwarder(path);
  return { forwarder: loadForwarder(path), wrote };
}

export interface SelfTestResult {
  ok: boolean;
  detail: string;
}

/**
 * Point every slot at a JavaScript callback and drive the stubs with sentinel
 * values. Verifies export resolution, slot storage, argument passing, and that
 * the return value comes back through the stub.
 */
export function selfTestForwarder(fwd: ForwarderModule): SelfTestResult {
  const seen: { name: string; args: number[] }[] = [];
  const createTarget = new JSCallback(
    (a: number, b: number, c: number, d: number) => {
      seen.push({ name: "create", args: [asPtr(a), b, asPtr(c), asPtr(d)] });
      return 0x1;
    },
    { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const evaluateTarget = new JSCallback(
    (a: number, b: number, c: number, d: number) => {
      seen.push({ name: "evaluate", args: [asPtr(a), asPtr(b), asPtr(c), asPtr(d)] });
      return 0x2;
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const releaseTarget = new JSCallback(
    (a: number) => {
      seen.push({ name: "release", args: [asPtr(a)] });
      return 0x3;
    },
    { args: [FFIType.ptr], returns: FFIType.i32 },
  );
  try {
    fwd.setSlots(asPtr(createTarget.ptr), asPtr(evaluateTarget.ptr), asPtr(releaseTarget.ptr));
    const r1 = fwd.create(0x1111, 18, 0x2222, 0x3333);
    const r2 = fwd.evaluate(0x4444, 0x5555, 0x6666, 0x7777);
    const r3 = fwd.release(0x8888);
    const expect = [
      { name: "create", args: [0x1111, 18, 0x2222, 0x3333] },
      { name: "evaluate", args: [0x4444, 0x5555, 0x6666, 0x7777] },
      { name: "release", args: [0x8888] },
    ];
    const argsOk = JSON.stringify(seen) === JSON.stringify(expect);
    const retOk = r1 === 1 && r2 === 2 && r3 === 3;
    if (argsOk && retOk) {
      return { ok: true, detail: "exports resolved, slots stored, four register arguments and return values pass through the call thunks" };
    }
    return { ok: false, detail: `mismatch: returns=[${r1},${r2},${r3}] seen=${JSON.stringify(seen)}` };
  } catch (error) {
    return { ok: false, detail: `self-test threw: ${(error as Error).message}` };
  } finally {
    createTarget.close();
    evaluateTarget.close();
    releaseTarget.close();
    // Leave the slots pointing at nothing dangerous.
    fwd.setSlots(0, 0, 0);
  }
}
