import { existsSync } from "node:fs";
import { expect, test } from "bun:test";
import { parseVersionInfo, readVersionInfo } from "../src/native/version-info.ts";
import {
  FEATURES,
  buildRuntimeCatalog,
  packVersionKey,
  parseVersionFromDirName,
} from "../src/ngx/runtime-catalog.ts";

const RUNTIME_DIR = "runtime";
const REAL_DLSS = "runtime/dlss/nvngx_dlss.dll";

/**
 * Build a minimal PE32+ file whose only resource is an RT_VERSION blob. The
 * blob deliberately starts with a FixedFileInfo signature that is NOT followed
 * by dwStrucVersion (a false positive) before the real one, and encodes a
 * product version distinct from the file version, plus a StringFileInfo
 * "FileVersion" display string. Section RVA == raw pointer so RVAs are offsets.
 */
function buildSyntheticPe(): Uint8Array {
  const buf = new Uint8Array(0x1100);
  const view = new DataView(buf.buffer);
  // DOS header
  view.setUint16(0, 0x5a4d, true); // "MZ"
  view.setUint32(0x3c, 0x80, true); // e_lfanew -> PE header

  const pe = 0x80;
  view.setUint32(pe, 0x00004550, true); // "PE\0\0"
  const coff = pe + 4;
  view.setUint16(coff, 0x8664, true); // machine x64
  view.setUint16(coff + 2, 1, true); // one section
  const optSize = 240;
  view.setUint16(coff + 16, optSize, true); // SizeOfOptionalHeader
  view.setUint16(coff + 18, 0x2000, true); // characteristics: DLL

  const opt = coff + 20;
  view.setUint16(opt, 0x20b, true); // PE32+ magic
  view.setUint32(opt + 56, 0x2000, true); // SizeOfImage
  view.setUint32(opt + 108, 16, true); // NumberOfRvaAndSizes
  const dirs = opt + 112;
  const RES_RVA = 0x1000;
  view.setUint32(dirs + 2 * 8, RES_RVA, true); // data directory[2] = resource RVA
  view.setUint32(dirs + 2 * 8 + 4, 0x200, true); // resource size

  // Section table (one ".rsrc" mapped identity: rawPointer == virtualAddress)
  const sec = opt + optSize;
  const name = ".rsrc";
  for (let i = 0; i < name.length; i++) buf[sec + i] = name.charCodeAt(i);
  view.setUint32(sec + 8, 0x200, true); // VirtualSize
  view.setUint32(sec + 12, RES_RVA, true); // VirtualAddress
  view.setUint32(sec + 16, 0x200, true); // SizeOfRawData
  view.setUint32(sec + 20, RES_RVA, true); // PointerToRawData

  // Resource tree (offsets relative to RES_RVA; high bit marks a subdirectory)
  const SUB = 0x80000000;
  // Level 1: type directory, one id entry (RT_VERSION = 16)
  view.setUint16(RES_RVA + 14, 1, true); // NumberOfIdEntries
  view.setUint32(RES_RVA + 16, 16, true); // Id = RT_VERSION
  view.setUint32(RES_RVA + 20, SUB | 0x18, true);
  // Level 2: name directory, one entry
  view.setUint16(RES_RVA + 0x18 + 14, 1, true);
  view.setUint32(RES_RVA + 0x28, 1, true);
  view.setUint32(RES_RVA + 0x2c, SUB | 0x30, true);
  // Level 3: language directory, one entry -> data entry (high bit clear)
  view.setUint16(RES_RVA + 0x30 + 14, 1, true);
  view.setUint32(RES_RVA + 0x40, 0x409, true);
  view.setUint32(RES_RVA + 0x44, 0x48, true);
  // Data entry: OffsetToData(RVA), Size
  const BLOB_RVA = RES_RVA + 0x60;
  view.setUint32(RES_RVA + 0x48, BLOB_RVA, true);
  view.setUint32(RES_RVA + 0x4c, 0x80, true); // blob size

  // Blob: false-positive signature, then the real FixedFileInfo
  view.setUint32(BLOB_RVA, 0xfeef04bd, true);
  view.setUint32(BLOB_RVA + 4, 0xdeadbeef, true); // NOT strucVersion -> skipped
  const fix = BLOB_RVA + 16;
  view.setUint32(fix, 0xfeef04bd, true);
  view.setUint32(fix + 4, 0x00010000, true); // dwStrucVersion
  view.setUint32(fix + 8, 0x01360007, true); // fileVersionMS -> 310.7
  view.setUint32(fix + 12, 0x00810000, true); // fileVersionLS -> 129.0
  view.setUint32(fix + 16, 0x01360007, true); // productVersionMS -> 310.7
  view.setUint32(fix + 20, 0x00000000, true); // productVersionLS -> 0.0

  // StringFileInfo "FileVersion" = "310.7.SF.0" (UTF-16LE), 4-aligned to blob
  const keyOff = BLOB_RVA + 64;
  const key = "FileVersion";
  for (let i = 0; i < key.length; i++) view.setUint16(keyOff + i * 2, key.charCodeAt(i), true);
  const valOff = keyOff + (key.length + 1) * 2; // past the key's null wchar
  const val = "310.7.SF.0";
  for (let i = 0; i < val.length; i++) view.setUint16(valOff + i * 2, val.charCodeAt(i), true);
  return buf;
}

test("parseVersionInfo reads a synthetic VS_VERSION_INFO, skipping the false-positive signature", () => {
  const info = parseVersionInfo(buildSyntheticPe());
  expect(info.fileVersion).toBe("310.7.129.0");
  expect(info.productVersion).toBe("310.7.0.0"); // distinct from file version
  expect(info.stringFileVersion).toBe("310.7.SF.0"); // display label preserved
});

test("parseVersionInfo never throws on non-PE / truncated input", () => {
  expect(parseVersionInfo(new Uint8Array(0))).toEqual({
    fileVersion: null,
    productVersion: null,
    stringFileVersion: null,
  });
  expect(parseVersionInfo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
    fileVersion: null,
    productVersion: null,
    stringFileVersion: null,
  });
  // A valid MZ/PE shell with no resource directory returns nulls, not garbage.
  const shell = new Uint8Array(0x200);
  const v = new DataView(shell.buffer);
  v.setUint16(0, 0x5a4d, true);
  v.setUint32(0x3c, 0x80, true);
  v.setUint32(0x80, 0x00004550, true);
  v.setUint16(0x80 + 4, 0x8664, true);
  v.setUint16(0x80 + 4 + 20, 0x20b, true);
  expect(parseVersionInfo(shell).fileVersion).toBeNull();
});

test("packVersionKey is monotonic and component-packed", () => {
  expect(packVersionKey("1.0.0.0")).toBe(1n << 48n);
  expect(packVersionKey("310.7.129.0")).toBeGreaterThan(packVersionKey("310.7.0.0"));
  expect(packVersionKey("310.7.0.0")).toBeGreaterThan(packVersionKey("310.6.0.0"));
  expect(packVersionKey("0.0.0.0")).toBe(0n);
  // A non-numeric component collapses to 0 rather than throwing.
  expect(packVersionKey("310.8.SF.0")).toBe((310n << 48n) | (8n << 32n));
});

test("parseVersionFromDirName extracts DLSS Swapper folder versions", () => {
  expect(parseVersionFromDirName("dlss_v310.7.129.0_D54BE95CFD9DF08C6EBA49DA2E1A2B7E")).toBe("310.7.129.0");
  expect(parseVersionFromDirName("dlss_g_v310.6.0.0_8187325390F03F2FE0B23BCBF28FE615")).toBe("310.6.0.0");
  expect(parseVersionFromDirName("no-version-here")).toBeNull();
});

test("FEATURES map the four DLSS features to the correct NGX ids and filenames", () => {
  const byKey = Object.fromEntries(FEATURES.map((f) => [f.key, f]));
  expect(byKey.sr).toMatchObject({ id: 1, dllName: "nvngx_dlss.dll" });
  expect(byKey.fg).toMatchObject({ id: 11, dllName: "nvngx_dlssg.dll" });
  expect(byKey.rr).toMatchObject({ id: 13, dllName: "nvngx_dlssd.dll" });
  expect(byKey.nr).toMatchObject({ id: 18, dllName: "nvngx_dlssnr.dll" });
});

test("buildRuntimeCatalog is total and returns all four features", () => {
  // Guarded fs access: a bogus dir yields empty version lists, never throws.
  const empty = buildRuntimeCatalog("W:/definitely/not/here", "W:/also/not/here");
  expect(empty.features.map((f) => f.id)).toEqual([1, 11, 13, 18]);
  for (const f of empty.features) expect(f.versions).toEqual([]);
});

// The task guarantees runtime/dlss/nvngx_dlss.dll exists; assert the real read.
const hasRealDll = existsSync(REAL_DLSS);
test.if(hasRealDll)("readVersionInfo reads a 310.x version from the real nvngx_dlss.dll", async () => {
  const info = await readVersionInfo(REAL_DLSS);
  expect(info.fileVersion).toMatch(/^310\.\d+\.\d+\.\d+$/);
});

test.if(hasRealDll)("buildRuntimeCatalog lists SR with a 310.x version, sorted newest-first", () => {
  const manifest = buildRuntimeCatalog(RUNTIME_DIR);
  const sr = manifest.features.find((f) => f.id === 1)!;
  expect(sr.dllName).toBe("nvngx_dlss.dll");
  expect(sr.versions.length).toBeGreaterThan(0);
  expect(sr.versions[0]!.version).toMatch(/^310\./);
  expect(sr.versions[0]!.sizeMB).toBeGreaterThan(0);
  // Descending by packed version key.
  for (let i = 1; i < sr.versions.length; i++) {
    expect(BigInt(sr.versions[i - 1]!.sortKey) >= BigInt(sr.versions[i]!.sortKey)).toBe(true);
  }
});
