/**
 * Emits the caller-validation shim as an x64 PE DLL built byte by byte in
 * TypeScript, so the build needs no C compiler.
 *
 * NVIDIA's neural-rendering runtime checks which module called into the NGX core
 * and returns PlatformError (0xBAD00002) for callers it does not recognise; a
 * module on disk literally named `nvngx.dll` is accepted. The host parks the NGX
 * core's function addresses in this DLL's slots and calls its stubs, and because
 * each stub uses a real `call` rather than a tail `jmp`, the return address on
 * the stack points back into this image — so the caller check sees `nvngx.dll`.
 *
 * The emitted code is position independent (RIP-relative slot access, exports as
 * RVAs, no imports, no absolute addresses), so an empty relocation table is
 * enough to satisfy ASLR.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { rename } from "node:fs/promises";

const IMAGE_DOS_SIGNATURE = 0x5a4d;
const IMAGE_NT_SIGNATURE = 0x00004550;
const SECTION_ALIGNMENT = 0x1000;
const FILE_ALIGNMENT = 0x200;
const DEFAULT_IMAGE_BASE = 0x180000000n;

/** Slots the exported stubs read their targets from, in this fixed order. */
export const FORWARDER_EXPORTS = ["fwd_create", "fwd_evaluate", "fwd_release", "fwd_set_slots"] as const;

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

/** Emits x64 machine code and resolves RIP-relative references to the .data slots. */
class TextBuilder {
  private readonly bytes: number[] = [];

  constructor(
    readonly textRva: number,
    readonly slotRva: number[],
  ) {}

  get rva(): number {
    return this.textRva + this.bytes.length;
  }

  private push(...values: number[]): void {
    for (const v of values) this.bytes.push(v & 0xff);
  }

  private disp32(value: number): void {
    this.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  /** mov [rip+disp], <reg>; `slot` indexes into slotRva. */
  private ripStore(prefix: number[], slot: number): void {
    this.push(...prefix);
    const ripAfter = this.textRva + this.bytes.length + 4;
    this.disp32(this.slotRva[slot]! - ripAfter);
  }

  /** DllMain: return TRUE. */
  emitDllMain(): number {
    const at = this.rva;
    this.push(0xb8, 0x01, 0x00, 0x00, 0x00); // mov eax, 1
    this.push(0xc3); // ret
    return at;
  }

  /** fwd_set_slots(rcx=create, rdx=evaluate, r8=release). */
  emitSetSlots(): number {
    const at = this.rva;
    this.ripStore([0x48, 0x89, 0x0d], 0); // mov [rip+slot0], rcx
    this.ripStore([0x48, 0x89, 0x15], 1); // mov [rip+slot1], rdx
    this.ripStore([0x4c, 0x89, 0x05], 2); // mov [rip+slot2], r8
    this.push(0xc3); // ret
    return at;
  }

  /**
   * A stub that reserves shadow space and calls the target held in `slot`. The
   * four register arguments (rcx/rdx/r8/r9) forward for free; `stackArgs` further
   * arguments ride the stack (Init_Ext has one, Init_ProjectID three) and are
   * copied from the caller's frame into the inner call's argument slots. Copying
   * more than a call actually passes is harmless: the extra copies land in shadow
   * space the callee never reads.
   */
  emitCallThunk(slot: number, stackArgs = 0): number {
    const at = this.rva;
    // Keep the frame 16-byte aligned at the inner call (rsp ≡ 8 mod 16 on entry).
    let frame = 0x20 + stackArgs * 8 + 8;
    if (frame % 16 !== 8) frame += 8;
    this.push(0x48, 0x83, 0xec, frame & 0xff); // sub rsp, frame
    for (let i = 0; i < stackArgs; i++) {
      // caller frame: arg(5+i) at [rsp + frame + 0x28 + i*8]; inner slot: [rsp + 0x20 + i*8]
      this.push(0x48, 0x8b, 0x84, 0x24); // mov rax, [rsp + disp32]
      this.disp32(frame + 0x28 + i * 8);
      this.push(0x48, 0x89, 0x84, 0x24); // mov [rsp + disp32], rax
      this.disp32(0x20 + i * 8);
    }
    this.push(0xff, 0x15); // call [rip+disp]
    {
      const ripAfter = this.textRva + this.bytes.length + 4;
      this.disp32(this.slotRva[slot]! - ripAfter);
    }
    this.push(0x48, 0x83, 0xc4, frame & 0xff); // add rsp, frame
    this.push(0xc3); // ret
    return at;
  }

  padTo(multiple: number): void {
    while (this.bytes.length % multiple !== 0) this.bytes.push(0);
  }

  get length(): number {
    return this.bytes.length;
  }

  toArray(): number[] {
    return this.bytes;
  }
}

export interface ForwarderLayout {
  bytes: Uint8Array;
  imageBase: bigint;
  exports: { name: string; rva: number }[];
}

export function buildForwarderDll(options: { imageBase?: bigint } = {}): ForwarderLayout {
  const imageBase = options.imageBase ?? DEFAULT_IMAGE_BASE;
  const textRva = 0x1000;
  const dataRva = 0x2000;
  const relocRva = 0x3000;
  const slotRva = [dataRva, dataRva + 8, dataRva + 16];

  // --- .text: entry point, stubs, then the export directory ---
  const text = new TextBuilder(textRva, slotRva);
  const dllMainRva = text.emitDllMain();
  const createRva = text.emitCallThunk(0, 3);
  const evaluateRva = text.emitCallThunk(1, 3);
  const releaseRva = text.emitCallThunk(2, 3);
  const setSlotsRva = text.emitSetSlots();
  text.padTo(16);

  // Exported RVAs keyed by the names in FORWARDER_EXPORTS (EAT order).
  const eatRva: Record<string, number> = {
    fwd_create: createRva,
    fwd_evaluate: evaluateRva,
    fwd_release: releaseRva,
    fwd_set_slots: setSlotsRva,
  };
  const names = [...FORWARDER_EXPORTS].sort(); // GetProcAddress binary-searches names

  const count = names.length;
  const exportDirRva = textRva + text.length;
  const eatTableRva = exportDirRva + 40;
  const namePtrRva = eatTableRva + count * 4;
  const ordinalsRva = namePtrRva + count * 4;
  const stringsRva = ordinalsRva + count * 2;

  const strings: number[] = [];
  const stringRva = (offset: number): number => stringsRva + offset;
  const dllNameOffset = strings.length;
  for (const c of "nvngx.dll") strings.push(c.charCodeAt(0));
  strings.push(0);
  const nameOffsets = names.map((name) => {
    const offset = strings.length;
    for (const c of name) strings.push(c.charCodeAt(0));
    strings.push(0);
    return offset;
  });

  const exportEndRva = stringsRva + strings.length;
  const exportSize = exportEndRva - exportDirRva;
  const textVirtualSize = exportEndRva - textRva;

  const textBytes = new Uint8Array(textVirtualSize);
  textBytes.set(text.toArray(), 0);
  const tv = new DataView(textBytes.buffer);
  const w32 = (rva: number, value: number) => tv.setUint32(rva - textRva, value >>> 0, true);
  const w16 = (rva: number, value: number) => tv.setUint16(rva - textRva, value & 0xffff, true);

  // IMAGE_EXPORT_DIRECTORY
  w32(exportDirRva + 12, stringRva(dllNameOffset));
  w32(exportDirRva + 16, 1); // ordinal base
  w32(exportDirRva + 20, count); // number of functions
  w32(exportDirRva + 24, count); // number of names
  w32(exportDirRva + 28, eatTableRva);
  w32(exportDirRva + 32, namePtrRva);
  w32(exportDirRva + 36, ordinalsRva);
  for (let i = 0; i < count; i++) {
    w32(eatTableRva + i * 4, eatRva[names[i]!]!);
    w32(namePtrRva + i * 4, stringRva(nameOffsets[i]!));
    w16(ordinalsRva + i * 2, i); // name i -> EAT index i
  }
  textBytes.set(strings, stringsRva - textRva);

  // --- .data: three 8-byte slots, zero-initialised ---
  const dataBytes = new Uint8Array(24);

  // --- .reloc: a single empty block, so DYNAMIC_BASE has a table to point at ---
  const relocBytes = new Uint8Array(8);
  new DataView(relocBytes.buffer).setUint32(0, textRva, true); // page RVA
  new DataView(relocBytes.buffer).setUint32(4, 8, true); // block size = header only (no fixups)

  // --- assemble the file ---
  const headerSize = align(64 + 4 + 20 + 240 + 3 * 40, FILE_ALIGNMENT);
  const textRaw = align(textBytes.length, FILE_ALIGNMENT);
  const dataRaw = align(dataBytes.length, FILE_ALIGNMENT);
  const relocRaw = align(relocBytes.length, FILE_ALIGNMENT);
  const textPtr = headerSize;
  const dataPtr = textPtr + textRaw;
  const relocPtr = dataPtr + dataRaw;
  const fileSize = relocPtr + relocRaw;
  const sizeOfImage = align(relocRva + relocBytes.length, SECTION_ALIGNMENT);

  const file = new Uint8Array(fileSize);
  const view = new DataView(file.buffer);
  const u8 = (o: number, v: number) => view.setUint8(o, v & 0xff);
  const u16 = (o: number, v: number) => view.setUint16(o, v & 0xffff, true);
  const u32 = (o: number, v: number) => view.setUint32(o, v >>> 0, true);
  const u64 = (o: number, v: bigint) => view.setBigUint64(o, BigInt.asUintN(64, v), true);

  // DOS header
  u16(0, IMAGE_DOS_SIGNATURE);
  u32(0x3c, 0x40); // e_lfanew -> PE signature right after the 64-byte DOS header

  // PE signature + COFF header
  const pe = 0x40;
  u32(pe, IMAGE_NT_SIGNATURE);
  const coff = pe + 4;
  u16(coff + 0, 0x8664); // Machine = AMD64
  u16(coff + 2, 3); // NumberOfSections
  u16(coff + 16, 240); // SizeOfOptionalHeader
  u16(coff + 18, 0x2022); // EXECUTABLE | LARGE_ADDRESS_AWARE | DLL

  // Optional header (PE32+)
  const opt = coff + 20;
  u16(opt + 0, 0x20b);
  u8(opt + 2, 14); // linker version major
  u32(opt + 4, textRaw); // SizeOfCode
  u32(opt + 8, dataRaw + relocRaw); // SizeOfInitializedData
  u32(opt + 16, dllMainRva); // AddressOfEntryPoint
  u32(opt + 20, textRva); // BaseOfCode
  u64(opt + 24, imageBase);
  u32(opt + 32, SECTION_ALIGNMENT);
  u32(opt + 36, FILE_ALIGNMENT);
  u16(opt + 40, 6); // MajorOperatingSystemVersion
  u16(opt + 48, 6); // MajorSubsystemVersion
  u32(opt + 56, sizeOfImage);
  u32(opt + 60, headerSize);
  u16(opt + 68, 3); // Subsystem = Windows CUI (loads fine for a DLL)
  u16(opt + 70, 0x140); // DYNAMIC_BASE | NX_COMPAT
  u64(opt + 72, 0x100000n); // SizeOfStackReserve
  u64(opt + 80, 0x1000n); // SizeOfStackCommit
  u64(opt + 88, 0x100000n); // SizeOfHeapReserve
  u64(opt + 96, 0x1000n); // SizeOfHeapCommit
  u32(opt + 108, 16); // NumberOfRvaAndSizes
  const dirs = opt + 112;
  u32(dirs + 0 * 8, exportDirRva); // Export table
  u32(dirs + 0 * 8 + 4, exportSize);
  u32(dirs + 5 * 8, relocRva); // Base relocation table
  u32(dirs + 5 * 8 + 4, relocBytes.length);

  // Section headers
  const sectionBase = opt + 240;
  const writeSection = (
    index: number,
    name: string,
    virtualSize: number,
    virtualAddress: number,
    rawSize: number,
    rawPtr: number,
    characteristics: number,
  ): void => {
    const base = sectionBase + index * 40;
    for (let i = 0; i < 8; i++) u8(base + i, i < name.length ? name.charCodeAt(i) : 0);
    u32(base + 8, virtualSize);
    u32(base + 12, virtualAddress);
    u32(base + 16, rawSize);
    u32(base + 20, rawPtr);
    u32(base + 36, characteristics);
  };
  writeSection(0, ".text", textBytes.length, textRva, textRaw, textPtr, 0x60000020); // CODE|EXECUTE|READ
  writeSection(1, ".data", dataBytes.length, dataRva, dataRaw, dataPtr, 0xc0000040); // INIT|READ|WRITE
  writeSection(2, ".reloc", relocBytes.length, relocRva, relocRaw, relocPtr, 0x42000040); // INIT|READ|DISCARDABLE

  file.set(textBytes, textPtr);
  file.set(dataBytes, dataPtr);
  file.set(relocBytes, relocPtr);

  return {
    bytes: file,
    imageBase,
    exports: names.map((name) => ({ name, rva: eatRva[name]! })),
  };
}

const inflightWrites = new Map<string, Promise<{ path: string; wrote: boolean; size: number }>>();
let tmpSeq = 0;

/**
 * Write the shim to `path` unless an identical file is already there. Concurrent
 * writes to the same path in this process are coalesced (two first-run
 * `/api/probe` requests would otherwise both write it), and the write goes
 * through a temp file + rename so a concurrent loader never maps a half-written
 * DLL.
 */
export function writeForwarder(path: string): Promise<{ path: string; wrote: boolean; size: number }> {
  const existing = inflightWrites.get(path);
  if (existing) return existing;
  const p = doWriteForwarder(path).finally(() => inflightWrites.delete(path));
  inflightWrites.set(path, p);
  return p;
}

async function doWriteForwarder(path: string): Promise<{ path: string; wrote: boolean; size: number }> {
  const built = buildForwarderDll();
  const existing = Bun.file(path);
  if (await existing.exists()) {
    const current = new Uint8Array(await existing.arrayBuffer());
    if (current.length === built.bytes.length && current.every((b, i) => b === built.bytes[i])) {
      return { path, wrote: false, size: built.bytes.length };
    }
  }
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq++}`;
  await Bun.write(tmp, built.bytes);
  try {
    await rename(tmp, path); // atomic on the first run (destination absent)
  } catch {
    await Bun.write(path, built.bytes); // rename can fail on Windows if the dest exists/locked
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  return { path, wrote: true, size: built.bytes.length };
}

/** Synchronous sibling of writeForwarder, for callers that cannot await (engine factories). */
export function writeForwarderSync(path: string): { path: string; wrote: boolean; size: number } {
  const built = buildForwarderDll();
  if (existsSync(path)) {
    const current = readFileSync(path);
    if (current.length === built.bytes.length && current.every((b, i) => b === built.bytes[i])) {
      return { path, wrote: false, size: built.bytes.length };
    }
  }
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq++}`;
  writeFileSync(tmp, built.bytes);
  try {
    renameSync(tmp, path); // atomic on the first run (destination absent)
  } catch {
    writeFileSync(path, built.bytes); // rename can fail on Windows if the dest exists/locked
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  return { path, wrote: true, size: built.bytes.length };
}
