/**
 * Loads the generated nvngx.dll shim and exposes its exports as typed calls,
 * plus a self-test that proves the call path end to end without touching NVIDIA
 * code.
 */
import { FFIType, JSCallback } from "bun:ffi";
import { join } from "node:path";
import { callableAt } from "../native/com.ts";
import { asPtr } from "../native/memory.ts";
import { LOAD_WITH_ALTERED_SEARCH_PATH, NativeModule } from "../native/win32.ts";
import { FORWARDER_EXPORTS, type ForwarderExportName } from "./forwarder.ts";
import { type ShimWrite, writeForwarder, writeForwarderSync } from "./forwarder-install.ts";

// The shim's call signatures: CreateFeature, EvaluateFeature and ReleaseFeature as NGX declares them, and a
// seven-argument call (as Init_ProjectID) whose last three arguments ride the stack.
const SET_SLOTS_SIGNATURE = { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void };
const CREATE_SIGNATURE = { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 };
const EVALUATE_SIGNATURE = { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 };
const RELEASE_SIGNATURE = { args: [FFIType.ptr], returns: FFIType.i32 };
const STACK_CALL_SIGNATURE = { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 };

export interface ForwarderModule {
  readonly path: string;
  readonly module: NativeModule;
  /** Address of each export; `fwd_create` is also re-bound to other NGX signatures (see NgxCore.fn). */
  readonly addresses: Record<ForwarderExportName, number>;
  setSlots(create: number, evaluate: number, release: number): void;
  create(cmdList: number, featureId: number, params: number, outHandle: number): number;
  evaluate(cmdList: number, handle: number, params: number, callback: number): number;
  release(handle: number): number;
}

export function loadForwarder(path: string): ForwarderModule {
  const module = NativeModule.load(path, LOAD_WITH_ALTERED_SEARCH_PATH);
  const addresses = {} as Record<ForwarderExportName, number>;
  for (const name of FORWARDER_EXPORTS) addresses[name] = module.requireProc(name);

  const setSlots = callableAt(addresses.fwd_set_slots, SET_SLOTS_SIGNATURE);
  const create = callableAt(addresses.fwd_create, CREATE_SIGNATURE);
  const evaluate = callableAt(addresses.fwd_evaluate, EVALUATE_SIGNATURE);
  const release = callableAt(addresses.fwd_release, RELEASE_SIGNATURE);

  const nullIfZero = (pointer: number) => (pointer === 0 ? null : pointer);
  return {
    path,
    module,
    addresses,
    setSlots: (createSlot, evaluateSlot, releaseSlot) => {
      setSlots(nullIfZero(createSlot), nullIfZero(evaluateSlot), nullIfZero(releaseSlot));
    },
    create: (cmdList, featureId, params, outHandle) => create(nullIfZero(cmdList), featureId, nullIfZero(params), nullIfZero(outHandle)) as number,
    evaluate: (cmdList, handle, params, callback) => evaluate(nullIfZero(cmdList), nullIfZero(handle), nullIfZero(params), nullIfZero(callback)) as number,
    release: (handle) => release(nullIfZero(handle)) as number,
  };
}

/** Where the generated shim sits inside `dir`: NGX accepts calls only from a module named nvngx.dll. */
export function shimPath(dir: string): string {
  return join(dir, "nvngx.dll");
}

/** Generate the shim under `dir` (as `nvngx.dll`) and load it. */
export async function prepareForwarder(dir: string): Promise<{ forwarder: ForwarderModule; status: ShimWrite }> {
  const path = shimPath(dir);
  const { status } = await writeForwarder(path);
  return { forwarder: loadForwarder(path), status };
}

/** Synchronous sibling of prepareForwarder, for callers that cannot await (engine factories). */
export function prepareForwarderSync(dir: string): { forwarder: ForwarderModule; status: ShimWrite } {
  const path = shimPath(dir);
  const { status } = writeForwarderSync(path);
  return { forwarder: loadForwarder(path), status };
}

export interface SelfTestResult {
  ok: boolean;
  detail: string;
}

/**
 * Stack-argument passthrough: a 7-argument call (as Init_ProjectID) puts arguments 5..7 on the stack, and the thunk
 * must copy them into the inner call frame. Returns whether they arrived, and what the target saw.
 */
function checkStackArguments(fwd: ForwarderModule): { ok: boolean; seen: number[] } {
  const seen: number[] = [];
  const target = new JSCallback(
    (arg1: number, arg2: number, arg3: number, arg4: number, arg5: number, arg6: number, arg7: number) => {
      seen.push(asPtr(arg1), arg2, asPtr(arg3), asPtr(arg4), asPtr(arg5), arg6, asPtr(arg7));
      return 0x2a;
    },
    STACK_CALL_SIGNATURE,
  );
  try {
    fwd.setSlots(asPtr(target.ptr), 0, 0);
    const result = callableAt(fwd.addresses.fwd_create, STACK_CALL_SIGNATURE)(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77) as number;
    return { ok: result === 0x2a && JSON.stringify(seen) === JSON.stringify([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]), seen };
  } finally {
    target.close();
  }
}

/**
 * Point every slot at a JavaScript callback and drive the stubs with sentinel
 * values, checking export resolution, slot storage, argument passing and the
 * returned value. A loaded-but-broken shim would otherwise only show up as a
 * fault inside NVIDIA code.
 */
export function selfTestForwarder(fwd: ForwarderModule): SelfTestResult {
  const seen: { name: string; args: number[] }[] = [];
  const createTarget = new JSCallback(
    (cmdList: number, featureId: number, params: number, outHandle: number) => {
      seen.push({ name: "create", args: [asPtr(cmdList), featureId, asPtr(params), asPtr(outHandle)] });
      return 0x1;
    },
    CREATE_SIGNATURE,
  );
  const evaluateTarget = new JSCallback(
    (cmdList: number, handle: number, params: number, callback: number) => {
      seen.push({ name: "evaluate", args: [asPtr(cmdList), asPtr(handle), asPtr(params), asPtr(callback)] });
      return 0x2;
    },
    EVALUATE_SIGNATURE,
  );
  const releaseTarget = new JSCallback(
    (handle: number) => {
      seen.push({ name: "release", args: [asPtr(handle)] });
      return 0x3;
    },
    RELEASE_SIGNATURE,
  );
  try {
    fwd.setSlots(asPtr(createTarget.ptr), asPtr(evaluateTarget.ptr), asPtr(releaseTarget.ptr));
    const createResult = fwd.create(0x1111, 18, 0x2222, 0x3333);
    const evaluateResult = fwd.evaluate(0x4444, 0x5555, 0x6666, 0x7777);
    const releaseResult = fwd.release(0x8888);
    const expect = [
      { name: "create", args: [0x1111, 18, 0x2222, 0x3333] },
      { name: "evaluate", args: [0x4444, 0x5555, 0x6666, 0x7777] },
      { name: "release", args: [0x8888] },
    ];
    const argsOk = JSON.stringify(seen) === JSON.stringify(expect);
    const retOk = createResult === 1 && evaluateResult === 2 && releaseResult === 3;
    const stack = checkStackArguments(fwd);
    if (argsOk && retOk && stack.ok) {
      return { ok: true, detail: "exports resolved, slots stored; four register arguments, seven mixed register and stack arguments, and return values pass through the call thunks" };
    }
    return {
      ok: false,
      detail: `mismatch: returns=[${createResult},${evaluateResult},${releaseResult}] stackOk=${stack.ok} seen=${JSON.stringify(seen)} seen7=${JSON.stringify(stack.seen)}`,
    };
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
