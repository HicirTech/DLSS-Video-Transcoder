/**
 * Builds the nvngx.dll caller-validation shim, an x64 PE DLL emitted byte by byte so the build needs no C compiler.
 * NGX returns PlatformError (0xBAD00002) unless its caller is a module named nvngx.dll, so each stub makes a real call
 * into the NGX target parked in its slot and the return address on the stack stays inside this image.
 */
import { IMAGE_DOS_SIGNATURE, IMAGE_NT_OPTIONAL_HDR64_MAGIC, IMAGE_NT_SIGNATURE } from "../native/pe.ts";

// Field offsets and flags: IMAGE_DOS_HEADER, IMAGE_FILE_HEADER, IMAGE_OPTIONAL_HEADER64, IMAGE_SECTION_HEADER and
// IMAGE_EXPORT_DIRECTORY in winnt.h ("PE format", learn.microsoft.com/windows/win32/debug/pe-format).
const SECTION_ALIGNMENT = 0x1000;
const FILE_ALIGNMENT = 0x200;
const IMAGE_BASE = 0x180000000n;
const DOS_HEADER_BYTES = 64;
const COFF_HEADER_BYTES = 20;
const OPTIONAL_HEADER_BYTES = 240; // PE32+ optional header with its 16 data directories
const DATA_DIRECTORY_COUNT = 16;
const SECTION_HEADER_BYTES = 40;
const EXPORT_DIRECTORY_BYTES = 40;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x0020;
const IMAGE_FILE_DLL = 0x2000;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3; // a DLL loads fine with it
const IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE = 0x0040;
const IMAGE_DLLCHARACTERISTICS_NX_COMPAT = 0x0100;
const IMAGE_SCN_CNT_CODE = 0x20;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x40;
const IMAGE_SCN_MEM_DISCARDABLE = 0x02000000;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SCN_MEM_WRITE = 0x80000000;
const EXPORT_DIRECTORY_INDEX = 0;
// IMAGE_DIRECTORY_ENTRY_EXCEPTION: data directory 3, at PE32+ optional header offset 136 (PE format).
const EXCEPTION_DIRECTORY_INDEX = 3;
const BASERELOC_DIRECTORY_INDEX = 5;

/** The .data slots fwd_set_slots fills, one 8-byte NGX target each. */
const SLOT = { create: 0, evaluate: 1, release: 2 } as const;
const SLOT_COUNT = 3;
const SLOT_BYTES = 8;
/** Init_ProjectID's three stack arguments: the most any forwarded NGX call passes. */
const MAX_STACK_ARGS = 3;

/**
 * The shim's exports. fwd_create, fwd_evaluate and fwd_release each call the
 * target parked in one .data slot; fwd_set_slots is what parks them, so it is
 * the writer rather than a fourth slot. This array's order is not load-bearing:
 * the export table is emitted name-sorted below and every name is resolved
 * through GetProcAddress.
 */
export const FORWARDER_EXPORTS = ["fwd_create", "fwd_evaluate", "fwd_release", "fwd_set_slots"] as const;
export type ForwarderExportName = (typeof FORWARDER_EXPORTS)[number];

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

// Unwind data, per "x64 exception handling" (learn.microsoft.com/cpp/build/exception-handling-x64):
// RUNTIME_FUNCTION is BeginAddress, EndAddress, UnwindInfoAddress (three ULONG RVAs, DWORD aligned,
// sorted by address); UNWIND_INFO is Version:3|Flags:5, SizeOfProlog, CountOfCodes,
// FrameRegister:4|FrameOffset:4, then the codes padded to an even count, DWORD aligned.
const RUNTIME_FUNCTION_BYTES = 12;
const UNWIND_INFO_VERSION = 1;
const UWOP_ALLOC_SMALL = 2;
/** Largest UWOP_ALLOC_SMALL allocation: OpInfo * 8 + 8 with a 4-bit OpInfo. */
const ALLOC_SMALL_MAX = 128;

/** A non-leaf function the unwinder has to describe: `sub rsp, frameBytes` as its whole prolog. */
interface CallThunkFrame {
  beginRva: number;
  endRva: number;
  prologBytes: number;
  frameBytes: number;
}

/**
 * The UNWIND_CODE slots (USHORT: CodeOffset | UnwindOp << 8 | OpInfo << 12) that undo a
 * `sub rsp, frameBytes` ending `prologBytes` into the function. Only UWOP_ALLOC_SMALL (8..128 bytes)
 * is encoded: the stubs' frames are 72 bytes (emitCallThunk), and a larger frame would also need
 * UWOP_ALLOC_LARGE, an imm32 `sub rsp` and, from one page up, a __chkstk probe ("x64 prolog and epilog").
 */
export function stackAllocationUnwindCodes(prologBytes: number, frameBytes: number): number[] {
  if (frameBytes < 8 || frameBytes % 8 !== 0 || frameBytes > ALLOC_SMALL_MAX) {
    throw new Error(`forwarder: stack frame of ${frameBytes} bytes; the stubs allocate a multiple of 8 from 8 to ${ALLOC_SMALL_MAX}`);
  }
  return [prologBytes | (UWOP_ALLOC_SMALL << 8) | ((frameBytes / 8 - 1) << 12)];
}

/** One UNWIND_INFO: version 1, no handler, no frame register, and the stack allocation's codes. */
function unwindInfo(frame: CallThunkFrame): number[] {
  const codes = stackAllocationUnwindCodes(frame.prologBytes, frame.frameBytes);
  const bytes = [UNWIND_INFO_VERSION, frame.prologBytes, codes.length, 0];
  for (let slot = 0; slot < align(codes.length, 2); slot++) {
    const code = codes[slot] ?? 0;
    bytes.push(code & 0xff, code >>> 8);
  }
  return bytes;
}

/**
 * The .pdata section, so a stack walk or exception dispatch that passes through a stub reaches its caller: the
 * RUNTIME_FUNCTION table first (what the exception directory names), then each UNWIND_INFO.
 */
function buildPdata(frames: CallThunkFrame[], pdataRva: number): { bytes: Uint8Array; tableBytes: number } {
  const sorted = [...frames].sort((a, b) => a.beginRva - b.beginRva);
  const tableBytes = sorted.length * RUNTIME_FUNCTION_BYTES;
  const infos = sorted.map(unwindInfo);
  const infoOffsets: number[] = [];
  let size = tableBytes;
  for (const info of infos) {
    infoOffsets.push(size);
    size = align(size + info.length, 4);
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  sorted.forEach((frame, index) => {
    const entry = index * RUNTIME_FUNCTION_BYTES;
    view.setUint32(entry, frame.beginRva, true);
    view.setUint32(entry + 4, frame.endRva, true);
    view.setUint32(entry + 8, pdataRva + infoOffsets[index]!, true);
    bytes.set(infos[index]!, infoOffsets[index]!);
  });
  return { bytes, tableBytes };
}

/** Emits x64 machine code and resolves RIP-relative references to the .data slots. */
class TextBuilder {
  private readonly bytes: number[] = [];
  /** The non-leaf functions emitted so far; DllMain and fwd_set_slots touch no stack and call nothing, so they need no entry. */
  readonly callThunks: CallThunkFrame[] = [];

  constructor(
    readonly textRva: number,
    readonly slotRva: readonly number[],
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

  /** The disp32 of a RIP-relative operand naming `slot`, the last four bytes of its instruction. */
  private ripRelativeSlot(slot: number): void {
    const ripAfter = this.textRva + this.bytes.length + 4;
    this.disp32(this.slotRva[slot]! - ripAfter);
  }

  /** mov [rip+disp], <reg>; `slot` indexes into slotRva. */
  private ripStore(prefix: number[], slot: number): void {
    this.push(...prefix);
    this.ripRelativeSlot(slot);
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
    this.ripStore([0x48, 0x89, 0x0d], SLOT.create); // mov [rip+slot0], rcx
    this.ripStore([0x48, 0x89, 0x15], SLOT.evaluate); // mov [rip+slot1], rdx
    this.ripStore([0x4c, 0x89, 0x05], SLOT.release); // mov [rip+slot2], r8
    this.push(0xc3); // ret
    return at;
  }

  /**
   * A stub that reserves shadow space and calls the target held in `slot`, with a real `call` rather than a tail
   * `jmp` so the return address the caller check reads stays inside this image. The four register arguments
   * (rcx/rdx/r8/r9) forward for free; `stackArgs` further arguments ride the stack (Init_Ext has one,
   * Init_ProjectID three) and are copied from the caller's frame into the inner call's argument slots. Copying
   * more than a call actually passes is harmless: the extra copies fill the inner call's argument 5-7 slots above
   * the 0x20 shadow space, which this frame reserves and a callee with fewer parameters never reads, and the source
   * reads stay inside the caller's already-committed stack.
   */
  emitCallThunk(slot: number, stackArgs = 0): number {
    const at = this.rva;
    // Keep the frame 16-byte aligned at the inner call (rsp ≡ 8 mod 16 on entry).
    let frame = 0x20 + stackArgs * 8 + 8;
    if (frame % 16 !== 8) frame += 8;
    this.adjustRsp(0xec, frame); // sub rsp, frame: the whole prolog
    const prologBytes = this.rva - at;
    for (let i = 0; i < stackArgs; i++) {
      // caller frame: arg(5+i) at [rsp + frame + 0x28 + i*8]; inner slot: [rsp + 0x20 + i*8]
      this.push(0x48, 0x8b, 0x84, 0x24); // mov rax, [rsp + disp32]
      this.disp32(frame + 0x28 + i * 8);
      this.push(0x48, 0x89, 0x84, 0x24); // mov [rsp + disp32], rax
      this.disp32(0x20 + i * 8);
    }
    this.push(0xff, 0x15); // call [rip+disp]
    this.ripRelativeSlot(slot);
    // The epilog is `add rsp, frame; ret`, one of the forms the unwinder recognises ("x64 prolog and epilog").
    this.adjustRsp(0xc4, frame); // add rsp, frame
    this.push(0xc3); // ret
    this.callThunks.push({ beginRva: at, endRva: this.rva, prologBytes, frameBytes: frame });
    return at;
  }

  /**
   * `sub rsp, bytes` (ModRM 0xec) or `add rsp, bytes` (0xc4) with an imm8. A frame is 8 mod 16, so the
   * 128-byte limit of stackAllocationUnwindCodes keeps it at 120 or less, inside the imm8's 0x7f; a
   * larger frame makes buildForwarderDll throw there before it returns any bytes.
   */
  private adjustRsp(modrm: 0xec | 0xc4, bytes: number): void {
    this.push(0x48, 0x83, modrm, bytes);
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

/** Where one table of the image lives: an IMAGE_DATA_DIRECTORY. */
interface DataDirectory {
  rva: number;
  size: number;
}

interface TextSection {
  bytes: Uint8Array;
  entryRva: number;
  exportDirectory: DataDirectory;
  exports: { name: string; rva: number }[];
  callThunks: CallThunkFrame[];
}

/** The .text section: the entry point and the stubs, then the export directory with its tables and strings. */
function buildTextSection(textRva: number, slotRva: readonly number[]): TextSection {
  const text = new TextBuilder(textRva, slotRva);
  const entryRva = text.emitDllMain();
  const eatRva: Record<ForwarderExportName, number> = {
    fwd_create: text.emitCallThunk(SLOT.create, MAX_STACK_ARGS),
    fwd_evaluate: text.emitCallThunk(SLOT.evaluate, MAX_STACK_ARGS),
    fwd_release: text.emitCallThunk(SLOT.release, MAX_STACK_ARGS),
    fwd_set_slots: text.emitSetSlots(),
  };
  text.padTo(16);
  const names = [...FORWARDER_EXPORTS].sort(); // GetProcAddress binary-searches names

  const count = names.length;
  const exportDirRva = textRva + text.length;
  const eatTableRva = exportDirRva + EXPORT_DIRECTORY_BYTES;
  const namePtrRva = eatTableRva + count * 4;
  const ordinalsRva = namePtrRva + count * 4;
  const stringsRva = ordinalsRva + count * 2;

  const strings: number[] = [];
  const addString = (value: string): number => {
    const rva = stringsRva + strings.length;
    for (const c of value) strings.push(c.charCodeAt(0));
    strings.push(0);
    return rva;
  };
  const dllNameRva = addString("nvngx.dll");
  const nameRvas = names.map(addString);
  const exportEndRva = stringsRva + strings.length;

  const bytes = new Uint8Array(exportEndRva - textRva);
  bytes.set(text.toArray(), 0);
  const textView = new DataView(bytes.buffer);
  const writeU32At = (rva: number, value: number) => textView.setUint32(rva - textRva, value >>> 0, true);
  const writeU16At = (rva: number, value: number) => textView.setUint16(rva - textRva, value & 0xffff, true);

  // IMAGE_EXPORT_DIRECTORY: Name @12, Base @16, NumberOfFunctions @20, NumberOfNames @24, AddressOfFunctions @28,
  // AddressOfNames @32, AddressOfNameOrdinals @36.
  writeU32At(exportDirRva + 12, dllNameRva);
  writeU32At(exportDirRva + 16, 1); // ordinal base
  writeU32At(exportDirRva + 20, count);
  writeU32At(exportDirRva + 24, count);
  writeU32At(exportDirRva + 28, eatTableRva);
  writeU32At(exportDirRva + 32, namePtrRva);
  writeU32At(exportDirRva + 36, ordinalsRva);
  names.forEach((name, index) => {
    writeU32At(eatTableRva + index * 4, eatRva[name]);
    writeU32At(namePtrRva + index * 4, nameRvas[index]!);
    writeU16At(ordinalsRva + index * 2, index); // name i -> EAT index i
  });
  bytes.set(strings, stringsRva - textRva);

  return {
    bytes,
    entryRva,
    exportDirectory: { rva: exportDirRva, size: exportEndRva - exportDirRva },
    exports: names.map((name) => ({ name, rva: eatRva[name] })),
    callThunks: text.callThunks,
  };
}

/**
 * A .reloc section of one empty block: DYNAMIC_BASE needs a table to point at, and the code is position independent
 * (RIP-relative slot access, exports as RVAs, no imports, no absolute addresses), so ASLR needs no fixup.
 */
function emptyRelocBlock(pageRva: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, pageRva, true); // page RVA
  view.setUint32(4, 8, true); // block size = header only (no fixups)
  return bytes;
}

interface ImageSection {
  name: string;
  rva: number;
  bytes: Uint8Array;
  characteristics: number;
}

/** The PE file: DOS, COFF and optional headers, the data directories and section headers, then each section's bytes. */
function assembleImage(image: { sections: ImageSection[]; entryRva: number; directories: Record<number, DataDirectory> }): Uint8Array {
  const { sections } = image;
  const headerSize = align(DOS_HEADER_BYTES + 4 + COFF_HEADER_BYTES + OPTIONAL_HEADER_BYTES + sections.length * SECTION_HEADER_BYTES, FILE_ALIGNMENT);
  const rawSizes = sections.map((section) => align(section.bytes.length, FILE_ALIGNMENT));
  const rawPointers: number[] = [];
  let fileSize = headerSize;
  for (const rawSize of rawSizes) {
    rawPointers.push(fileSize);
    fileSize += rawSize;
  }
  const rawSizeWhere = (flag: number): number => sections.reduce((sum, section, index) => ((section.characteristics & flag) !== 0 ? sum + rawSizes[index]! : sum), 0);
  const code = sections.find((section) => (section.characteristics & IMAGE_SCN_CNT_CODE) !== 0)!;
  const last = sections[sections.length - 1]!;

  const file = new Uint8Array(fileSize);
  const view = new DataView(file.buffer);
  const u8 = (o: number, v: number) => view.setUint8(o, v & 0xff);
  const u16 = (o: number, v: number) => view.setUint16(o, v & 0xffff, true);
  const u32 = (o: number, v: number) => view.setUint32(o, v >>> 0, true);
  const u64 = (o: number, v: bigint) => view.setBigUint64(o, BigInt.asUintN(64, v), true);

  // IMAGE_DOS_HEADER: e_magic, and e_lfanew naming the NT headers right after the 64-byte DOS header
  u16(0, IMAGE_DOS_SIGNATURE);
  u32(0x3c, DOS_HEADER_BYTES);
  const pe = DOS_HEADER_BYTES;
  u32(pe, IMAGE_NT_SIGNATURE);

  // IMAGE_FILE_HEADER
  const coff = pe + 4;
  u16(coff + 0, IMAGE_FILE_MACHINE_AMD64); // Machine
  u16(coff + 2, sections.length); // NumberOfSections
  u16(coff + 16, OPTIONAL_HEADER_BYTES); // SizeOfOptionalHeader
  u16(coff + 18, IMAGE_FILE_EXECUTABLE_IMAGE | IMAGE_FILE_LARGE_ADDRESS_AWARE | IMAGE_FILE_DLL); // Characteristics

  // IMAGE_OPTIONAL_HEADER64
  const opt = coff + COFF_HEADER_BYTES;
  u16(opt + 0, IMAGE_NT_OPTIONAL_HDR64_MAGIC); // Magic
  u8(opt + 2, 14); // MajorLinkerVersion
  u32(opt + 4, rawSizeWhere(IMAGE_SCN_CNT_CODE)); // SizeOfCode
  u32(opt + 8, rawSizeWhere(IMAGE_SCN_CNT_INITIALIZED_DATA)); // SizeOfInitializedData
  u32(opt + 16, image.entryRva); // AddressOfEntryPoint
  u32(opt + 20, code.rva); // BaseOfCode
  u64(opt + 24, IMAGE_BASE); // ImageBase
  u32(opt + 32, SECTION_ALIGNMENT); // SectionAlignment
  u32(opt + 36, FILE_ALIGNMENT); // FileAlignment
  u16(opt + 40, 6); // MajorOperatingSystemVersion
  u16(opt + 48, 6); // MajorSubsystemVersion
  u32(opt + 56, align(last.rva + last.bytes.length, SECTION_ALIGNMENT)); // SizeOfImage
  u32(opt + 60, headerSize); // SizeOfHeaders
  u16(opt + 68, IMAGE_SUBSYSTEM_WINDOWS_CUI); // Subsystem
  u16(opt + 70, IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE | IMAGE_DLLCHARACTERISTICS_NX_COMPAT); // DllCharacteristics
  u64(opt + 72, 0x100000n); // SizeOfStackReserve
  u64(opt + 80, 0x1000n); // SizeOfStackCommit
  u64(opt + 88, 0x100000n); // SizeOfHeapReserve
  u64(opt + 96, 0x1000n); // SizeOfHeapCommit
  u32(opt + 108, DATA_DIRECTORY_COUNT); // NumberOfRvaAndSizes
  for (const [index, directory] of Object.entries(image.directories)) {
    u32(opt + 112 + Number(index) * 8, directory.rva);
    u32(opt + 112 + Number(index) * 8 + 4, directory.size);
  }

  // IMAGE_SECTION_HEADER: Name[8] @0, VirtualSize @8, VirtualAddress @12, SizeOfRawData @16, PointerToRawData @20,
  // Characteristics @36; each section's bytes then go to its raw pointer.
  sections.forEach((section, index) => {
    const header = opt + OPTIONAL_HEADER_BYTES + index * SECTION_HEADER_BYTES;
    for (let i = 0; i < 8; i++) u8(header + i, i < section.name.length ? section.name.charCodeAt(i) : 0);
    u32(header + 8, section.bytes.length);
    u32(header + 12, section.rva);
    u32(header + 16, rawSizes[index]!);
    u32(header + 20, rawPointers[index]!);
    u32(header + 36, section.characteristics);
    file.set(section.bytes, rawPointers[index]!);
  });
  return file;
}

export interface ForwarderLayout {
  bytes: Uint8Array;
  exports: { name: string; rva: number }[];
}

export function buildForwarderDll(): ForwarderLayout {
  const textRva = 0x1000;
  const dataRva = 0x2000;
  const pdataRva = 0x3000;
  const relocRva = 0x4000;
  const slotRva = Array.from({ length: SLOT_COUNT }, (_, slot) => dataRva + slot * SLOT_BYTES);

  const text = buildTextSection(textRva, slotRva);
  const pdata = buildPdata(text.callThunks, pdataRva);
  const reloc = emptyRelocBlock(textRva);
  const bytes = assembleImage({
    sections: [
      { name: ".text", rva: textRva, bytes: text.bytes, characteristics: IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ },
      // The slots, zero-initialised until fwd_set_slots fills them.
      { name: ".data", rva: dataRva, bytes: new Uint8Array(SLOT_COUNT * SLOT_BYTES), characteristics: IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE },
      { name: ".pdata", rva: pdataRva, bytes: pdata.bytes, characteristics: IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ },
      { name: ".reloc", rva: relocRva, bytes: reloc, characteristics: IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_DISCARDABLE },
    ],
    entryRva: text.entryRva,
    directories: {
      [EXPORT_DIRECTORY_INDEX]: text.exportDirectory,
      [EXCEPTION_DIRECTORY_INDEX]: { rva: pdataRva, size: pdata.tableBytes }, // the RUNTIME_FUNCTION array
      [BASERELOC_DIRECTORY_INDEX]: { rva: relocRva, size: reloc.length },
    },
  });
  return { bytes, exports: text.exports };
}
