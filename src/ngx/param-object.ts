/**
 * Our own NVSDK_NGX_Parameter object, for driving a feature snippet DLL directly.
 *
 * The snippet DLLs (nvngx_dlss.dll, nvngx_dlssg.dll, nvngx_dlssnr.dll) export
 * CreateFeature / EvaluateFeature but NOT AllocateParameters /
 * GetCapabilityParameters — those live only in the driver's NGX core — so a
 * snippet driven in-process must be handed a parameter object we own: a
 * C++-style object whose first field points at a vtable of Set / Get / Reset
 * methods, laid out in MSVC's reverse-declaration order (the "msvc" layout in
 * params.ts). It is backed by a plain JavaScript map, so the runtime and our own
 * code read and write one store.
 */
import { FFIType, JSCallback } from "bun:ffi";
import { NativeStruct, asPtr, readCString, viewNative } from "../native/memory.ts";
import { MSVC, type Slots } from "./params.ts";
import { NGX_SUCCESS, NgxResult } from "./results.ts";

const NOT_FOUND = 0xbad00004 | 0; // NVSDK_NGX_Result_FeatureNotFound, used for "parameter unset"

type Value = number | bigint;

/** Writes a stored value into the caller's out-pointer with the getter's width. */
type Writer = (view: DataView, value: Value) => void;

/** Each setter's value type, and how a value is stored: a u64 as a bigint, so a getter reads it back at full width. */
const SETTERS: ReadonlyArray<{ slot: keyof Slots; type: FFIType; toStore?: (value: Value) => Value }> = [
  { slot: "setPointer", type: FFIType.u64 },
  { slot: "setD3d12", type: FFIType.u64 },
  { slot: "setD3d11", type: FFIType.u64 },
  { slot: "setI32", type: FFIType.i32 },
  { slot: "setU32", type: FFIType.u32 },
  { slot: "setF64", type: FFIType.f64 },
  { slot: "setF32", type: FFIType.f32 },
  { slot: "setU64", type: FFIType.u64, toStore: (value) => BigInt(value) },
];

const writeU64: Writer = (view, value) => view.setBigUint64(0, BigInt(value), true);

const GETTERS: ReadonlyArray<{ slot: keyof Slots; write: Writer }> = [
  { slot: "getPointer", write: writeU64 },
  { slot: "getD3d12", write: writeU64 },
  { slot: "getD3d11", write: writeU64 },
  { slot: "getI32", write: (view, value) => view.setInt32(0, Number(value) | 0, true) },
  { slot: "getU32", write: (view, value) => view.setUint32(0, Number(value) >>> 0, true) },
  { slot: "getF64", write: (view, value) => view.setFloat64(0, Number(value), true) },
  { slot: "getF32", write: (view, value) => view.setFloat32(0, Number(value), true) },
  { slot: "getU64", write: writeU64 },
];

export class NgxParamObject {
  private readonly store = new Map<string, Value>();
  private readonly callbacks: JSCallback[] = [];
  private readonly vtable = new NativeStruct((MSVC.reset + 1) * 8);
  private readonly object: NativeStruct;
  private closed = false;

  constructor() {
    for (const setter of SETTERS) this.install(MSVC[setter.slot], this.setterCallback(setter.type, setter.toStore));
    for (const getter of GETTERS) this.install(MSVC[getter.slot], this.getterCallback(getter.write));
    this.install(MSVC.reset, new JSCallback(() => this.store.clear(), { args: [FFIType.ptr], returns: FFIType.void }));
    // Object layout: first 8 bytes point at the vtable; pad so stray reads stay inside our memory.
    this.object = new NativeStruct(64);
    this.object.pointer(0, this.vtable.ptr as unknown as number);
  }

  get ptr(): number {
    return this.object.ptr as unknown as number;
  }

  setU32(name: string, value: number): this {
    this.store.set(name, value >>> 0);
    return this;
  }
  setI32(name: string, value: number): this {
    this.store.set(name, value | 0);
    return this;
  }
  setF32(name: string, value: number): this {
    this.store.set(name, value);
    return this;
  }
  setF64(name: string, value: number): this {
    this.store.set(name, value);
    return this;
  }
  setU64(name: string, value: number | bigint): this {
    this.store.set(name, BigInt(value));
    return this;
  }
  /** Store a D3D12 resource / arbitrary pointer under `name`. */
  setResource(name: string, pointer: number): this {
    this.store.set(name, asPtr(pointer));
    return this;
  }
  setPointer(name: string, pointer: number): this {
    this.store.set(name, asPtr(pointer));
    return this;
  }

  getU32(name: string): number | null {
    return this.store.has(name) ? Number(this.store.get(name)) >>> 0 : null;
  }
  getI32(name: string): number | null {
    return this.store.has(name) ? Number(this.store.get(name)) | 0 : null;
  }
  getF32(name: string): number | null {
    return this.store.has(name) ? Number(this.store.get(name)) : null;
  }
  getF64(name: string): number | null {
    return this.store.has(name) ? Number(this.store.get(name)) : null;
  }
  getU64(name: string): bigint | null {
    return this.store.has(name) ? BigInt(this.store.get(name)!) : null;
  }
  getPointer(name: string): number | null {
    return this.store.has(name) ? Number(this.store.get(name)) : null;
  }

  reset(): void {
    this.store.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of this.callbacks) callback.close();
  }

  private install(slot: number, callback: JSCallback): void {
    this.callbacks.push(callback);
    this.vtable.pointer(slot * 8, asPtr(callback.ptr));
  }

  /** A setter: stores the value keyed by parameter name. */
  private setterCallback(type: FFIType, toStore?: (value: Value) => Value): JSCallback {
    return new JSCallback(
      (_self: number, namePtr: number, value: number | bigint) => {
        this.store.set(readCString(asPtr(namePtr), 256), toStore ? toStore(value) : value);
      },
      { args: [FFIType.ptr, FFIType.ptr, type], returns: FFIType.void },
    );
  }

  /** A getter: writes the stored value at the writer's width, or answers NOT_FOUND for a parameter never set. */
  private getterCallback(write: Writer): JSCallback {
    return new JSCallback(
      (_self: number, namePtr: number, outPtr: number) => {
        const name = readCString(asPtr(namePtr), 256);
        if (!this.store.has(name)) return NOT_FOUND;
        const bytes = viewNative(asPtr(outPtr), 8);
        write(new DataView(bytes.buffer, bytes.byteOffset, 8), this.store.get(name)!);
        return NGX_SUCCESS;
      },
      { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    );
  }
}
