/**
 * Calling COM interfaces from TypeScript: a COM object is a pointer to a
 * pointer to a vtable, and every method takes the object pointer as its first
 * argument. bun:ffi's CFunction turns a raw function address into a callable.
 */
import { CFunction, FFIType, read, type Pointer } from "bun:ffi";
import { asPtr, hex32 } from "./memory.ts";

export interface Signature {
  args: FFIType[];
  returns: FFIType;
}

type NativeCallable = (...args: unknown[]) => unknown;

const trampolines = new Map<string, NativeCallable>();

/** Build (and cache) a callable for a raw function address. */
export function callableAt(address: number, signature: Signature): NativeCallable {
  const key = `${address}|${signature.args.join(",")}|${signature.returns}`;
  let fn = trampolines.get(key);
  if (!fn) {
    fn = CFunction({ ptr: address as Pointer, args: signature.args, returns: signature.returns }) as unknown as NativeCallable;
    trampolines.set(key, fn);
  }
  return fn;
}

/** Resolve vtable slot `index` of a COM object and return a callable that already expects `this` first. */
export function vtableMethod(object: number, index: number, signature: Signature): NativeCallable {
  if (object === 0) throw new Error("vtableMethod: null COM object");
  const vtable = asPtr(read.ptr(object as Pointer, 0));
  const address = asPtr(read.ptr(vtable as Pointer, index * 8));
  if (address === 0) throw new Error(`vtableMethod: slot ${index} of object ${hex32(object)} is null`);
  return callableAt(address, { args: [FFIType.ptr, ...signature.args], returns: signature.returns });
}

export function isFailure(hresult: number): boolean {
  return (hresult | 0) < 0;
}

export function checkHresult(hresult: number, what: string): void {
  if (isFailure(hresult)) {
    throw new Error(`${what} failed with HRESULT ${hex32(hresult)}${describeHresult(hresult)}`);
  }
}

const KNOWN_HRESULTS: Record<string, string> = {
  "0x80004001": "E_NOTIMPL",
  "0x80004002": "E_NOINTERFACE",
  "0x80004005": "E_FAIL",
  "0x80070057": "E_INVALIDARG",
  "0x8007000E": "E_OUTOFMEMORY",
  "0x887A0001": "DXGI_ERROR_INVALID_CALL",
  "0x887A0002": "DXGI_ERROR_NOT_FOUND",
  "0x887A0004": "DXGI_ERROR_UNSUPPORTED",
  "0x887A0005": "DXGI_ERROR_DEVICE_REMOVED",
  "0x887A0006": "DXGI_ERROR_DEVICE_HUNG",
  "0x887A0007": "DXGI_ERROR_DEVICE_RESET",
  "0x887A0020": "DXGI_ERROR_DRIVER_INTERNAL_ERROR",
  "0x887E0003": "D3D12_ERROR_INVALID_REDIST",
};

export function describeHresult(hresult: number): string {
  const name = KNOWN_HRESULTS[hex32(hresult)];
  return name ? ` (${name})` : "";
}

/** Thin base class: owns one interface pointer and releases it exactly once. */
export class ComObject {
  private released = false;

  constructor(
    readonly ptr: number,
    readonly label: string,
  ) {
    if (ptr === 0) throw new Error(`${label}: null interface pointer`);
  }

  protected call(index: number, signature: Signature, ...args: unknown[]): unknown {
    return vtableMethod(this.ptr, index, signature)(this.ptr, ...args);
  }

  protected callHr(index: number, signature: Signature, what: string, ...args: unknown[]): void {
    const hr = this.call(index, { ...signature, returns: FFIType.i32 }, ...args) as number;
    checkHresult(hr, `${this.label}.${what}`);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    vtableMethod(this.ptr, 2, { args: [], returns: FFIType.u32 })(this.ptr);
  }
}
