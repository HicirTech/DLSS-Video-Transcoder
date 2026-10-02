/**
 * A named, paging-file-backed Windows file mapping seen as a Uint8Array: memory two processes share by
 * name instead of copying it through a pipe. Each process closes its own copy; Windows frees the
 * mapping once every process has closed it or died.
 */
import { toArrayBuffer, type Pointer } from "bun:ffi";
import { asPtr, hex32, wstring } from "./memory.ts";
import { kernel32Symbols, lastError } from "./win32.ts";

// hFile of CreateFileMappingW that asks for a mapping backed by the system paging file, not by a file
// (INVALID_HANDLE_VALUE): https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createfilemappingw
const BACKED_BY_PAGING_FILE = 0xffff_ffff_ffff_ffffn;
// flProtect, a read/write mapping: https://learn.microsoft.com/windows/win32/memory/memory-protection-constants
const PAGE_READWRITE = 0x04;
// Access for OpenFileMappingW and MapViewOfFile alike: a read/write view, which a PAGE_READWRITE mapping allows
// (value from memoryapi.h): https://learn.microsoft.com/windows/win32/memory/file-mapping-security-and-access-rights
const FILE_MAP_ALL_ACCESS = 0x000f001f;
// https://learn.microsoft.com/windows/win32/debug/system-error-codes--0-499-
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ALREADY_EXISTS = 183;
const BYTES_PER_HIGH_WORD = 0x1_0000_0000;

function requireByteLength(name: string, byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new Error(`Shared memory "${name}" needs a size of at least 1 byte, got ${byteLength}`);
  }
}

function win32Failure(call: string, name: string, code: number): string {
  return `${call} failed for shared memory "${name}": Win32 error ${code} (${hex32(code)})`;
}

export class SharedMemory {
  private closed = false;

  private constructor(
    readonly name: string,
    private readonly mappingHandle: number,
    private readonly viewAddress: number,
    private readonly view: Uint8Array,
  ) {}

  /** A new zero-filled mapping called `name`, which fails when a mapping of that name already exists. */
  static create(name: string, byteLength: number): SharedMemory {
    requireByteLength(name, byteLength);
    // The size is a 64-bit value passed as two 32-bit words.
    const created = kernel32Symbols.CreateFileMappingW(
      BACKED_BY_PAGING_FILE,
      null,
      PAGE_READWRITE,
      Math.floor(byteLength / BYTES_PER_HIGH_WORD),
      byteLength % BYTES_PER_HIGH_WORD,
      wstring(name),
    );
    // Read right away: the next Win32 call overwrites it. For an existing name Windows hands back that
    // mapping's handle and sets ERROR_ALREADY_EXISTS, which would share someone else's memory.
    const code = lastError();
    const handle = asPtr(created);
    if (handle === 0) throw new Error(win32Failure("CreateFileMappingW", name, code));
    if (code === ERROR_ALREADY_EXISTS) {
      kernel32Symbols.CloseHandle(handle as Pointer);
      throw new Error(`Shared memory "${name}" already exists; a new mapping needs a name no process has used`);
    }
    return SharedMemory.mapView(name, handle, byteLength);
  }

  /**
   * The mapping another process created as `name`, which must be at least `byteLength` bytes.
   * https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-openfilemappingw
   */
  static open(name: string, byteLength: number): SharedMemory {
    requireByteLength(name, byteLength);
    const opened = kernel32Symbols.OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, wstring(name));
    const code = lastError();
    const handle = asPtr(opened);
    if (handle === 0) {
      const gone = code === ERROR_FILE_NOT_FOUND ? "; no process holds a mapping of that name, which exists only while the process that created it keeps it open" : "";
      throw new Error(`${win32Failure("OpenFileMappingW", name, code)}${gone}`);
    }
    return SharedMemory.mapView(name, handle, byteLength);
  }

  /** Maps the first `byteLength` bytes of `handle`: https://learn.microsoft.com/windows/win32/api/memoryapi/nf-memoryapi-mapviewoffile */
  private static mapView(name: string, handle: number, byteLength: number): SharedMemory {
    const mapped = kernel32Symbols.MapViewOfFile(handle as Pointer, FILE_MAP_ALL_ACCESS, 0, 0, BigInt(byteLength));
    const code = lastError();
    const address = asPtr(mapped);
    if (address === 0) {
      kernel32Symbols.CloseHandle(handle as Pointer);
      // Windows reports a view larger than the mapping as error 5, "access denied".
      throw new Error(`${win32Failure("MapViewOfFile", name, code)}; the mapping may be smaller than the ${byteLength} bytes asked for`);
    }
    try {
      // Native memory the mapping owns, so the ArrayBuffer is given no deallocator; close() ends the view.
      return new SharedMemory(name, handle, address, new Uint8Array(toArrayBuffer(address as Pointer, 0, byteLength)));
    } catch (error) {
      // Bun 1.4.2 raises a RangeError for a Uint8Array over 2^32 bytes.
      kernel32Symbols.UnmapViewOfFile(address as Pointer);
      kernel32Symbols.CloseHandle(handle as Pointer);
      throw error;
    }
  }

  /**
   * The mapped bytes, zero-copy. They stop being memory when close() runs, and touching them then
   * crashes the process, so this throws once closed; a view taken before close() must not outlive it.
   * Never post them to a Worker, which would copy or detach them.
   */
  get bytes(): Uint8Array {
    if (this.closed) throw new Error(`Shared memory "${this.name}" was closed; its bytes are no longer mapped`);
    return this.view;
  }

  /**
   * Unmaps the view and closes this process's handle, both of which Windows needs before it frees the mapping; later
   * calls do nothing. Failures are not reported: close runs on error paths.
   * https://learn.microsoft.com/windows/win32/api/memoryapi/nf-memoryapi-unmapviewoffile
   * https://learn.microsoft.com/windows/win32/api/handleapi/nf-handleapi-closehandle
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    kernel32Symbols.UnmapViewOfFile(this.viewAddress as Pointer);
    kernel32Symbols.CloseHandle(this.mappingHandle as Pointer);
  }
}
