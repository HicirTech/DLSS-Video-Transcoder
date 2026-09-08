/**
 * Small helpers for talking to native code through bun:ffi: fixed-layout
 * structs, C / wide strings, GUIDs and pointer bookkeeping.
 *
 * Every buffer handed to native code must stay referenced from JavaScript for
 * as long as the native side may look at it. Callers keep the returned
 * Uint8Array / NativeStruct alive themselves.
 */
import { ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";

export type Ptr = Pointer;

/** Bun represents NULL as 0 or null depending on the call; normalise to a number. */
export function asPtr(value: Pointer | number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "bigint" ? Number(value) : Number(value);
}

export function isNull(value: Pointer | number | bigint | null | undefined): boolean {
  return asPtr(value) === 0;
}

/** Format a 32-bit value the way Windows tools print HRESULTs and NGX results. */
export function hex32(value: number | bigint): string {
  const n = typeof value === "bigint" ? Number(value & 0xffffffffn) : value >>> 0;
  return "0x" + n.toString(16).toUpperCase().padStart(8, "0");
}

export function hexPtr(value: Pointer | number | bigint | null | undefined): string {
  return "0x" + asPtr(value).toString(16).toUpperCase().padStart(16, "0");
}

/** A byte buffer with typed accessors at fixed offsets, used to build C structs by hand. */
export class NativeStruct {
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get ptr(): Pointer {
    return ptr(this.bytes);
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  u8(offset: number, value: number): this {
    this.view.setUint8(offset, value);
    return this;
  }

  u16(offset: number, value: number): this {
    this.view.setUint16(offset, value, true);
    return this;
  }

  u32(offset: number, value: number): this {
    this.view.setUint32(offset, value >>> 0, true);
    return this;
  }

  i32(offset: number, value: number): this {
    this.view.setInt32(offset, value | 0, true);
    return this;
  }

  u64(offset: number, value: number | bigint): this {
    this.view.setBigUint64(offset, BigInt.asUintN(64, BigInt(value)), true);
    return this;
  }

  f32(offset: number, value: number): this {
    this.view.setFloat32(offset, value, true);
    return this;
  }

  f64(offset: number, value: number): this {
    this.view.setFloat64(offset, value, true);
    return this;
  }

  pointer(offset: number, value: Pointer | number | bigint | null | undefined): this {
    return this.u64(offset, asPtr(value));
  }

  getU8(offset: number): number {
    return this.view.getUint8(offset);
  }

  getU16(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  getU32(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  getI32(offset: number): number {
    return this.view.getInt32(offset, true);
  }

  getU64(offset: number): bigint {
    return this.view.getBigUint64(offset, true);
  }

  getF32(offset: number): number {
    return this.view.getFloat32(offset, true);
  }

  getF64(offset: number): number {
    return this.view.getFloat64(offset, true);
  }

  getPtr(offset: number): number {
    return Number(this.view.getBigUint64(offset, true));
  }

  fill(value = 0): this {
    this.bytes.fill(value);
    return this;
  }
}

/** UTF-8 string with a terminating NUL, suitable for `const char*` arguments. */
export function cstring(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(encoded.length + 1);
  out.set(encoded);
  return out;
}

/** UTF-16LE string with a terminating NUL, suitable for `const wchar_t*` arguments. */
export function wstring(text: string): Uint8Array {
  const out = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

/** Read a NUL-terminated UTF-16LE string from native memory. */
export function readWString(address: Pointer | number, maxChars = 1024): string {
  const p = asPtr(address);
  if (p === 0) return "";
  const view = new Uint16Array(toArrayBuffer(p as Pointer, 0, maxChars * 2));
  let end = 0;
  while (end < view.length && view[end] !== 0) end++;
  return String.fromCharCode(...view.subarray(0, end));
}

/** Read a NUL-terminated UTF-8 string from native memory. */
export function readCString(address: Pointer | number, maxBytes = 4096): string {
  const p = asPtr(address);
  if (p === 0) return "";
  const bytes = new Uint8Array(toArrayBuffer(p as Pointer, 0, maxBytes));
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Copy `length` bytes out of native memory into a fresh Uint8Array. */
export function copyFromNative(address: Pointer | number, length: number): Uint8Array {
  const p = asPtr(address);
  if (p === 0 || length === 0) return new Uint8Array(0);
  return new Uint8Array(toArrayBuffer(p as Pointer, 0, length)).slice();
}

/** A zero-copy view over native memory. Only valid while the native allocation lives. */
export function viewNative(address: Pointer | number, length: number): Uint8Array {
  const p = asPtr(address);
  if (p === 0) throw new Error("viewNative: null pointer");
  return new Uint8Array(toArrayBuffer(p as Pointer, 0, length));
}

export function readPointer(address: Pointer | number, offset = 0): number {
  return asPtr(read.ptr(asPtr(address) as Pointer, offset));
}

/** Parse "{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}" into the 16-byte little-endian GUID layout. */
export function guid(text: string): Uint8Array {
  const clean = text.replace(/[{}]/g, "").toLowerCase();
  const parts = clean.split("-");
  if (parts.length !== 5 || !/^[0-9a-f-]{36}$/.test(clean)) {
    throw new Error(`Invalid GUID: ${text}`);
  }
  const out = new NativeStruct(16);
  out.u32(0, parseInt(parts[0]!, 16));
  out.u16(4, parseInt(parts[1]!, 16));
  out.u16(6, parseInt(parts[2]!, 16));
  const tail = parts[3]! + parts[4]!;
  for (let i = 0; i < 8; i++) out.u8(8 + i, parseInt(tail.substring(i * 2, i * 2 + 2), 16));
  return out.bytes;
}

/** An 8-byte cell used for `void**` style out-parameters. */
export class OutPointer {
  private readonly cell = new NativeStruct(8);

  get ptr(): Pointer {
    return this.cell.ptr;
  }

  get value(): number {
    return this.cell.getPtr(0);
  }

  reset(): this {
    this.cell.fill(0);
    return this;
  }
}

export class OutU32 {
  private readonly cell = new NativeStruct(8);
  get ptr(): Pointer {
    return this.cell.ptr;
  }
  get value(): number {
    return this.cell.getU32(0);
  }
}

export class OutU64 {
  private readonly cell = new NativeStruct(8);
  get ptr(): Pointer {
    return this.cell.ptr;
  }
  get value(): bigint {
    return this.cell.getU64(0);
  }
}

export class OutF32 {
  private readonly cell = new NativeStruct(8);
  get ptr(): Pointer {
    return this.cell.ptr;
  }
  get value(): number {
    return this.cell.getF32(0);
  }
}

export function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
