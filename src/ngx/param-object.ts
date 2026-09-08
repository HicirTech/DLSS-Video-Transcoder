/**
 * Our own NVSDK_NGX_Parameter object.
 *
 * The feature snippet DLLs (nvngx_dlss.dll, nvngx_dlssg.dll, nvngx_dlssnr.dll)
 * export CreateFeature / EvaluateFeature but NOT AllocateParameters /
 * GetCapabilityParameters — those live only in the driver's NGX core. To drive a
 * snippet directly in-process we must hand it a parameter object we own: a
 * C++-style object whose first field points at a vtable of Set / Get / Reset
 * methods. NVIDIA's static library lays adjacent overloads out in reverse
 * declaration order (the "msvc" layout in params.ts); this object implements
 * exactly that layout, backed by a plain JavaScript map, so both the runtime and
 * our own code read and write the same store.
 */
import { FFIType, JSCallback } from "bun:ffi";
import { NativeStruct, asPtr, readCString, viewNative } from "../native/memory.ts";
import { NGX_SUCCESS } from "./results.ts";

const NOT_FOUND = 0xbad00004 | 0; // NVSDK_NGX_Result_FeatureNotFound, used for "parameter unset"

type Value = number | bigint;

/** Writes a stored value into the caller's out-pointer with the getter's width. */
type Writer = (view: DataView, value: Value) => void;

const SETTER_TYPES: FFIType[] = [
  FFIType.u64, // 0 setPointer
  FFIType.u64, // 1 setD3d12
  FFIType.u64, // 2 setD3d11
  FFIType.i32, // 3 setI32
  FFIType.u32, // 4 setU32
  FFIType.f64, // 5 setF64
  FFIType.f32, // 6 setF32
  FFIType.u64, // 7 setU64
];

const WRITERS: Writer[] = [
  (v, x) => v.setBigUint64(0, BigInt(x), true), // 8 getPointer
  (v, x) => v.setBigUint64(0, BigInt(x), true), // 9 getD3d12
  (v, x) => v.setBigUint64(0, BigInt(x), true), // 10 getD3d11
  (v, x) => v.setInt32(0, Number(x) | 0, true), // 11 getI32
  (v, x) => v.setUint32(0, Number(x) >>> 0, true), // 12 getU32
  (v, x) => v.setFloat64(0, Number(x), true), // 13 getF64
  (v, x) => v.setFloat32(0, Number(x), true), // 14 getF32
  (v, x) => v.setBigUint64(0, BigInt(x), true), // 15 getU64
];

export class NgxParamObject {
  private readonly store = new Map<string, Value>();
  private readonly callbacks: JSCallback[] = [];
  private readonly vtable: NativeStruct;
  private readonly object: NativeStruct;
  private closed = false;

  constructor() {
    const slots = new NativeStruct(17 * 8);

    // Slots 0..7: setters store the value keyed by parameter name.
    for (let slot = 0; slot < 8; slot++) {
      const setU64Store = slot === 7;
      const cb = new JSCallback(
        (_self: number, namePtr: number, value: number | bigint) => {
          this.store.set(readCString(asPtr(namePtr), 256), setU64Store ? BigInt(value) : value);
        },
        { args: [FFIType.ptr, FFIType.ptr, SETTER_TYPES[slot]!], returns: FFIType.void },
      );
      this.callbacks.push(cb);
      slots.pointer(slot * 8, asPtr(cb.ptr));
    }

    // Slots 8..15: getters copy the stored value out and report found / not-found.
    for (let i = 0; i < 8; i++) {
      const write = WRITERS[i]!;
      const cb = new JSCallback(
        (_self: number, namePtr: number, outPtr: number) => {
          const name = readCString(asPtr(namePtr), 256);
          if (!this.store.has(name)) return NOT_FOUND;
          const bytes = viewNative(asPtr(outPtr), 8);
          write(new DataView(bytes.buffer, bytes.byteOffset, 8), this.store.get(name)!);
          return NGX_SUCCESS;
        },
        { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      );
      this.callbacks.push(cb);
      slots.pointer((8 + i) * 8, asPtr(cb.ptr));
    }

    // Slot 16: Reset clears the store.
    const reset = new JSCallback(() => this.store.clear(), { args: [FFIType.ptr], returns: FFIType.void });
    this.callbacks.push(reset);
    slots.pointer(16 * 8, asPtr(reset.ptr));

    this.vtable = slots;
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
    for (const cb of this.callbacks) cb.close();
  }
}
