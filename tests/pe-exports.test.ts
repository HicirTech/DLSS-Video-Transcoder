/**
 * parsePe's export table (src/native/pe.ts) on a hand-built PE32+ image: a function exported under several names is
 * listed once per name, and one exported by ordinal only is named "#ordinal". The one section maps RVA to the same
 * file offset, so the RVAs below are offsets too.
 */
import { expect, test } from "bun:test";
import { parsePe } from "../src/native/pe.ts";

const SECTION_RVA = 0x1000;
const ORDINAL_BASE = 1;
const ALIASED_FUNCTION_RVA = 0x1800;
const UNNAMED_FUNCTION_RVA = 0x1900;

function buildExportingPe(): Uint8Array {
  const bytes = new Uint8Array(0x1200);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x5a4d, true); // "MZ"
  view.setUint32(0x3c, 0x80, true); // e_lfanew
  view.setUint32(0x80, 0x00004550, true); // "PE\0\0"
  const coff = 0x84;
  view.setUint16(coff, 0x8664, true); // x64
  view.setUint16(coff + 2, 1, true); // one section
  view.setUint16(coff + 16, 240, true); // SizeOfOptionalHeader
  view.setUint16(coff + 18, 0x2000, true); // DLL
  const optional = coff + 20;
  view.setUint16(optional, 0x20b, true); // PE32+
  view.setUint32(optional + 108, 16, true); // NumberOfRvaAndSizes
  view.setUint32(optional + 112, SECTION_RVA, true); // DataDirectory[0], the exports
  view.setUint32(optional + 116, 0x100, true);
  const section = optional + 240;
  view.setUint32(section + 8, 0x200, true); // VirtualSize
  view.setUint32(section + 12, SECTION_RVA, true); // VirtualAddress
  view.setUint32(section + 16, 0x200, true); // SizeOfRawData
  view.setUint32(section + 20, SECTION_RVA, true); // PointerToRawData

  const exports = SECTION_RVA;
  view.setUint32(exports + 16, ORDINAL_BASE, true);
  view.setUint32(exports + 20, 2, true); // NumberOfFunctions
  view.setUint32(exports + 24, 2, true); // NumberOfNames
  view.setUint32(exports + 28, exports + 0x40, true); // AddressOfFunctions
  view.setUint32(exports + 32, exports + 0x50, true); // AddressOfNames
  view.setUint32(exports + 36, exports + 0x60, true); // AddressOfNameOrdinals
  view.setUint32(exports + 0x40, ALIASED_FUNCTION_RVA, true);
  view.setUint32(exports + 0x44, UNNAMED_FUNCTION_RVA, true);
  view.setUint32(exports + 0x50, exports + 0x80, true);
  view.setUint32(exports + 0x54, exports + 0x90, true);
  view.setUint16(exports + 0x60, 0, true); // both names index function 0
  view.setUint16(exports + 0x62, 0, true);
  new TextEncoder().encodeInto("Alpha\0", bytes.subarray(exports + 0x80));
  new TextEncoder().encodeInto("Beta\0", bytes.subarray(exports + 0x90));
  return bytes;
}

test("a function exported under two names is listed under both, with one ordinal and address", () => {
  const { exports } = parsePe(buildExportingPe());
  expect(exports.filter((entry) => entry.rva === ALIASED_FUNCTION_RVA)).toEqual([
    { name: "Alpha", ordinal: ORDINAL_BASE, rva: ALIASED_FUNCTION_RVA, forwarder: null },
    { name: "Beta", ordinal: ORDINAL_BASE, rva: ALIASED_FUNCTION_RVA, forwarder: null },
  ]);
});

test("a function exported by ordinal only is named after its ordinal", () => {
  const { exports } = parsePe(buildExportingPe());
  expect(exports.find((entry) => entry.rva === UNNAMED_FUNCTION_RVA)?.name).toBe(`#${ORDINAL_BASE + 1}`);
});
