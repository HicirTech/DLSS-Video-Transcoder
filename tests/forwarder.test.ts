import { expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildForwarderDll, FORWARDER_EXPORTS, stackAllocationUnwindCodes, writeForwarder, writeForwarderSync } from "../src/ngx/forwarder.ts";
import { loadForwarder, selfTestForwarder, type ForwarderModule } from "../src/ngx/forwarder-runtime.ts";
import { parsePe, type PeInfo } from "../src/native/pe.ts";

// The three stubs that call through a slot; each reserves shadow space plus three stack arguments,
// padded so the inner call is 16-byte aligned: 0x20 + 3 * 8 + 8 = 0x40, rounded to 8 mod 16.
const CALL_STUBS = ["fwd_create", "fwd_evaluate", "fwd_release"];
const CALL_STUB_FRAME = 0x48;
const SUB_RSP_IMM8 = [0x48, 0x83, 0xec, CALL_STUB_FRAME];
const ADD_RSP_IMM8_RET = [0x48, 0x83, 0xc4, CALL_STUB_FRAME, 0xc3];

interface RuntimeFunction {
  begin: number;
  end: number;
  unwindInfo: number;
}

function fileOffset(info: PeInfo, rva: number): number {
  const section = info.sections.find((s) => rva >= s.virtualAddress && rva < s.virtualAddress + s.virtualSize);
  if (!section) throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  return section.rawPointer + rva - section.virtualAddress;
}

/** Data directory 3 (exception table) of a PE32+ image: PE format, optional header offset 136. */
function exceptionDirectory(bytes: Uint8Array): { rva: number; size: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const optionalHeader = view.getUint32(0x3c, true) + 4 + 20;
  return { rva: view.getUint32(optionalHeader + 136, true), size: view.getUint32(optionalHeader + 140, true) };
}

function runtimeFunctions(bytes: Uint8Array, info: PeInfo): RuntimeFunction[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = exceptionDirectory(bytes);
  const entries: RuntimeFunction[] = [];
  for (let offset = 0; offset < directory.size; offset += 12) {
    const at = fileOffset(info, directory.rva + offset);
    entries.push({ begin: view.getUint32(at, true), end: view.getUint32(at + 4, true), unwindInfo: view.getUint32(at + 8, true) });
  }
  return entries;
}

test("generated shim is a well-formed x64 DLL with the expected exports", () => {
  const built = buildForwarderDll();
  const info = parsePe(built.bytes);
  expect(info.is64).toBe(true);
  expect(info.isDll).toBe(true);
  expect(info.machine).toBe(0x8664);
  expect(info.sections.map((s) => s.name)).toEqual([".text", ".data", ".pdata", ".reloc"]);
  expect(info.exports.map((e) => e.name)).toEqual([...FORWARDER_EXPORTS].sort());
  for (const e of info.exports) expect(e.forwarder).toBeNull();
});

test("every call stub has a sorted RUNTIME_FUNCTION in .pdata with a one-code UNWIND_INFO", () => {
  const built = buildForwarderDll();
  const info = parsePe(built.bytes);
  const text = info.sections.find((s) => s.name === ".text")!;
  const pdata = info.sections.find((s) => s.name === ".pdata")!;
  const directory = exceptionDirectory(built.bytes);
  expect(directory.rva).toBe(pdata.virtualAddress);
  expect(directory.size).toBe(CALL_STUBS.length * 12);
  expect(directory.rva + directory.size).toBeLessThanOrEqual(pdata.virtualAddress + pdata.virtualSize);

  const entries = runtimeFunctions(built.bytes, info);
  const stubRvas = info.exports.filter((e) => CALL_STUBS.includes(e.name)).map((e) => e.rva);
  expect(entries.map((e) => e.begin)).toEqual([...stubRvas].sort((a, b) => a - b));
  for (const [index, entry] of entries.entries()) {
    if (index > 0) expect(entry.begin).toBeGreaterThanOrEqual(entries[index - 1]!.end);
    expect(entry.begin).toBeGreaterThanOrEqual(text.virtualAddress);
    expect(entry.end).toBeLessThanOrEqual(text.virtualAddress + text.virtualSize);
    const code = built.bytes.subarray(fileOffset(info, entry.begin), fileOffset(info, entry.begin) + (entry.end - entry.begin));
    expect([...code.subarray(0, 4)]).toEqual(SUB_RSP_IMM8);
    expect([...code.subarray(code.length - 5)]).toEqual(ADD_RSP_IMM8_RET);

    expect(entry.unwindInfo % 4).toBe(0);
    const unwind = built.bytes.subarray(fileOffset(info, entry.unwindInfo), fileOffset(info, entry.unwindInfo) + 8);
    expect(unwind[0]).toBe(1); // Version 1, Flags 0
    expect(unwind[1]).toBe(SUB_RSP_IMM8.length); // SizeOfProlog: the sub rsp
    expect(unwind[2]).toBe(1); // CountOfCodes
    expect(unwind[3]).toBe(0); // no frame register
    expect(unwind[4]).toBe(SUB_RSP_IMM8.length); // CodeOffset: end of the sub rsp
    expect(unwind[5]).toBe(2 | ((CALL_STUB_FRAME / 8 - 1) << 4)); // UWOP_ALLOC_SMALL, OpInfo = size / 8 - 1
  }
});

test("a stack allocation of 8 to 128 bytes is one UWOP_ALLOC_SMALL code and any other frame is refused", () => {
  expect(stackAllocationUnwindCodes(4, 8)).toEqual([4 | (2 << 8)]);
  expect(stackAllocationUnwindCodes(4, 128)).toEqual([4 | (2 << 8) | (15 << 12)]);
  expect(() => stackAllocationUnwindCodes(7, 136)).toThrow("136 bytes");
  expect(() => stackAllocationUnwindCodes(4, 12)).toThrow("12 bytes");
});

test("the unwinder finds each loaded stub and unwinds it to its caller's return address", () => {
  const kernel32 = dlopen("kernel32.dll", {
    RtlLookupFunctionEntry: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    RtlVirtualUnwind: {
      args: [FFIType.u32, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
  });
  let dir: string | undefined;
  let fwd: ForwarderModule | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "forwarder-unwind-"));
    const path = join(dir, "nvngx.dll");
    const built = buildForwarderDll();
    writeFileSync(path, built.bytes);
    fwd = loadForwarder(path);
    const info = parsePe(built.bytes);
    const imageBase = fwd.module.handle;
    // CONTEXT (winnt.h, AMD64): 1232 bytes, 16-byte aligned; Rsp @0x98, Rip @0xF8.
    const contextStorage = new Uint8Array(1232 + 16);
    const context = contextStorage.subarray((16 - (ptr(contextStorage) % 16)) % 16).subarray(0, 1232);
    const contextView = new DataView(context.buffer, context.byteOffset, context.byteLength);
    // A synthetic stack: filler everywhere, the caller's return address only where the frame puts it.
    const stack = new Uint8Array(512);
    const stackView = new DataView(stack.buffer);
    const rspOffset = 64;
    const rsp = ptr(stack) + rspOffset;
    const returnAddress = 0x7ff6_1234_5678n;
    const handlerData = new Uint8Array(8);
    const establisherFrame = new Uint8Array(8);
    const foundBase = new Uint8Array(8);

    const unwindFrom = (controlPc: number, returnAddressAt: number): { rip: bigint; rsp: bigint } => {
      stack.fill(0x5a);
      stackView.setBigUint64(rspOffset + returnAddressAt, returnAddress, true);
      context.fill(0);
      contextView.setBigUint64(0x98, BigInt(rsp), true);
      contextView.setBigUint64(0xf8, BigInt(controlPc), true);
      const entry = kernel32.symbols.RtlLookupFunctionEntry(controlPc, foundBase, null);
      expect(Number(entry)).not.toBe(0);
      expect(Number(new DataView(foundBase.buffer).getBigUint64(0, true))).toBe(imageBase);
      kernel32.symbols.RtlVirtualUnwind(0, imageBase, controlPc, entry, context, handlerData, establisherFrame, null);
      return { rip: contextView.getBigUint64(0xf8, true), rsp: contextView.getBigUint64(0x98, true) };
    };

    for (const entry of runtimeFunctions(built.bytes, info)) {
      const epilog = entry.end - ADD_RSP_IMM8_RET.length;
      const cases = [
        { what: "entry, before the prolog", pc: entry.begin, returnAddressAt: 0 },
        { what: "body, after the prolog", pc: entry.begin + SUB_RSP_IMM8.length, returnAddressAt: CALL_STUB_FRAME },
        { what: "epilog add rsp, where the inner call returns", pc: epilog, returnAddressAt: CALL_STUB_FRAME },
        { what: "epilog ret", pc: entry.end - 1, returnAddressAt: 0 },
      ];
      for (const at of cases) {
        const unwound = unwindFrom(imageBase + at.pc, at.returnAddressAt);
        expect({ what: at.what, rip: unwound.rip }).toEqual({ what: at.what, rip: returnAddress });
        expect({ what: at.what, rsp: unwound.rsp }).toEqual({ what: at.what, rsp: BigInt(rsp + at.returnAddressAt + 8) });
      }
    }
  } finally {
    fwd?.module.free();
    kernel32.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("writeForwarderSync replaces a shim whose bytes differ and leaves an identical one alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "forwarder-write-"));
  const path = join(dir, "nvngx.dll");
  try {
    const built = buildForwarderDll();
    const stale = built.bytes.slice();
    stale[stale.length - 1] ^= 0xff;
    writeFileSync(path, stale);
    expect(writeForwarderSync(path).wrote).toBe(true);
    expect(Buffer.compare(readFileSync(path), built.bytes)).toBe(0);
    expect(writeForwarderSync(path).wrote).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SHIM_WRITERS = [
  { name: "writeForwarderSync", write: (path: string) => writeForwarderSync(path) },
  { name: "writeForwarder", write: (path: string) => writeForwarder(path) },
];

for (const { name, write } of SHIM_WRITERS) {
  test(`${name} leaves a loaded shim and no temp file, and replaces it once it is unloaded`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "forwarder-loaded-"));
    const path = join(dir, "nvngx.dll");
    const built = buildForwarderDll();
    // The loader ignores bytes past the last section: one extra byte still loads, so the file is mapped
    // while differing from what the writers emit.
    const loadable = new Uint8Array(built.bytes.length + 1);
    loadable.set(built.bytes);
    let loaded: ForwarderModule | undefined;
    try {
      writeFileSync(path, loadable);
      loaded = loadForwarder(path);

      expect((await write(path)).wrote).toBe(false);
      expect(Buffer.compare(readFileSync(path), loadable)).toBe(0);
      expect(readdirSync(dir)).toEqual(["nvngx.dll"]);

      loaded.module.free();
      loaded = undefined;
      expect((await write(path)).wrote).toBe(true);
      expect(Buffer.compare(readFileSync(path), built.bytes)).toBe(0);
      expect(readdirSync(dir)).toEqual(["nvngx.dll"]);
    } finally {
      loaded?.module.free();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("shim loads and forwards calls with arguments intact", () => {
  const dir = `${import.meta.dir}\\..\\runtime\\caller`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}\\nvngx.dll`;
  const built = buildForwarderDll();
  require("node:fs").writeFileSync(path, built.bytes);
  const fwd = loadForwarder(path);
  const result = selfTestForwarder(fwd);
  expect(result.detail).toContain("pass through");
  expect(result.ok).toBe(true);
  fwd.module.free();
});
