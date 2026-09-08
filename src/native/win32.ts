/**
 * The handful of Win32 calls this project needs, bound once through bun:ffi.
 */
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { asPtr, cstring, hex32, wstring } from "./memory.ts";

const kernel32 = dlopen("kernel32.dll", {
  LoadLibraryExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
  FreeLibrary: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetProcAddress: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
  GetModuleFileNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  CreateEventW: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetCurrentProcessId: { args: [], returns: FFIType.u32 },
  GetTickCount64: { args: [], returns: FFIType.u64 },
  MultiByteToWideChar: {
    args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
});

export const LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008;
export const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR = 0x00000100;
export const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS = 0x00001000;
export const INFINITE = 0xffffffff;
export const WAIT_OBJECT_0 = 0;

export class NativeModule {
  private constructor(
    readonly path: string,
    readonly handle: number,
  ) {}

  /** Load a DLL by absolute path. Dependencies resolve from the DLL's own folder and the system folders. */
  static load(path: string, flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS): NativeModule {
    const wide = wstring(path);
    const handle = asPtr(kernel32.symbols.LoadLibraryExW(wide, null, flags));
    if (handle === 0) {
      const code = kernel32.symbols.GetLastError();
      throw new Error(`LoadLibraryExW failed for ${path}: Win32 error ${code} (${hex32(code)})`);
    }
    return new NativeModule(path, handle);
  }

  /** Handle of a module that is already loaded in this process, or null. */
  static loaded(name: string): NativeModule | null {
    const handle = asPtr(kernel32.symbols.GetModuleHandleW(wstring(name)));
    return handle === 0 ? null : new NativeModule(name, handle);
  }

  /** Address of an exported function, or 0 when the export does not exist. */
  proc(name: string): number {
    return asPtr(kernel32.symbols.GetProcAddress(this.handle as Pointer, cstring(name)));
  }

  requireProc(name: string): number {
    const address = this.proc(name);
    if (address === 0) throw new Error(`${this.path} does not export ${name}`);
    return address;
  }

  free(): void {
    kernel32.symbols.FreeLibrary(this.handle as Pointer);
  }
}

export function lastError(): number {
  return kernel32.symbols.GetLastError();
}

export class Win32Event {
  readonly handle: number;

  constructor() {
    this.handle = asPtr(kernel32.symbols.CreateEventW(null, 0, 0, null));
    if (this.handle === 0) throw new Error(`CreateEventW failed: ${hex32(lastError())}`);
  }

  /** Block the calling thread until the event is signalled. Returns false on timeout. */
  wait(timeoutMs = INFINITE): boolean {
    const result = kernel32.symbols.WaitForSingleObject(this.handle as Pointer, timeoutMs);
    if (result === WAIT_OBJECT_0) return true;
    if (result === 0x00000102) return false; // WAIT_TIMEOUT
    throw new Error(`WaitForSingleObject failed: ${hex32(result)} (${hex32(lastError())})`);
  }

  close(): void {
    kernel32.symbols.CloseHandle(this.handle as Pointer);
  }
}

export function currentProcessId(): number {
  return kernel32.symbols.GetCurrentProcessId();
}

export function tickCount64(): bigint {
  return BigInt(kernel32.symbols.GetTickCount64());
}

/** Exposed so the forwarder self-test can route a six-argument call through generated code. */
export const kernel32Symbols = kernel32.symbols;
export const kernel32Module = NativeModule.loaded("kernel32.dll");
