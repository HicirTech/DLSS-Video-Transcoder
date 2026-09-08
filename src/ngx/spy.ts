/**
 * A "spy" NVSDK_NGX_Parameter: a C++-style object whose vtable slots are all
 * JavaScript callbacks. Handing it to the driver reveals which virtual slots
 * it calls and which parameter names it asks for, without any guessing about
 * the vtable layout. Every call is answered with UnsupportedParameter.
 */
import { FFIType, JSCallback } from "bun:ffi";
import { NativeStruct, asPtr, readCString } from "../native/memory.ts";

export interface SpyCall {
  slot: number;
  name: string;
  arg: string;
}

const UNSUPPORTED = 0xbad00010 | 0;

export class SpyParameter {
  readonly calls: SpyCall[] = [];
  private readonly callbacks: JSCallback[] = [];
  private readonly vtable: NativeStruct;
  private readonly object: NativeStruct;

  constructor(slots = 32) {
    this.vtable = new NativeStruct(slots * 8);
    for (let slot = 0; slot < slots; slot++) {
      const cb = new JSCallback(
        (_self: number, name: number, arg: bigint | number) => {
          let text = "";
          try {
            text = asPtr(name) > 0x10000 ? readCString(name, 128) : `<${asPtr(name)}>`;
          } catch {
            text = "<unreadable>";
          }
          this.calls.push({ slot, name: text, arg: "0x" + BigInt.asUintN(64, BigInt(arg)).toString(16) });
          return UNSUPPORTED;
        },
        { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      );
      this.callbacks.push(cb);
      this.vtable.pointer(slot * 8, asPtr(cb.ptr));
    }
    // Object layout: first 8 bytes point at the vtable; pad so reads past it stay inside our memory.
    this.object = new NativeStruct(64);
    this.object.pointer(0, this.vtable.ptr as unknown as number);
  }

  get ptr(): number {
    return this.object.ptr as unknown as number;
  }

  summary(): string {
    if (this.calls.length === 0) return "no virtual calls were made on the spy object";
    return this.calls.map((c) => `slot ${c.slot} name="${c.name}" arg=${c.arg}`).join("; ");
  }

  close(): void {
    for (const cb of this.callbacks) cb.close();
  }
}
