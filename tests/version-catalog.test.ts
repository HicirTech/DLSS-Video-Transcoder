/**
 * How the DLSS runtime catalog versions its DLLs: parsing VS_VERSION_INFO out of a PE (src/native/version-info.ts),
 * and packing, sorting and listing those versions per feature (src/ngx/runtime-catalog.ts). No GPU; the real-DLL
 * cases run only where runtime/dlss/nvngx_dlss.dll is installed.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { parseVersionInfo, readVersionInfo } from "../src/native/version-info.ts";
import {
  FEATURES,
  buildRuntimeCatalog,
  featureByKey,
  packVersionKey,
  parseVersionFromDirName,
} from "../src/ngx/runtime-catalog.ts";
import { DEFAULT_RUNTIME_DIR, featureDir } from "../src/paths.ts";

const REAL_DLSS = join(featureDir(DEFAULT_RUNTIME_DIR, "sr"), featureByKey("sr").dllName);

/** Where the synthetic PE's headers start (e_lfanew). */
const PE_HEADER_OFFSET = 0x80;
/** The RVA of the synthetic PE's only section, .rsrc, which is mapped identity: its raw pointer is its RVA. */
const RESOURCE_RVA = 0x1000;
/** IMAGE_FILE_HEADER.SizeOfOptionalHeader of a PE32+ image with all 16 data directories. */
const OPTIONAL_HEADER_BYTES = 240;

/** The MZ and PE headers of an x64 DLL; returns the optional header's offset. */
function writePeShell(view: DataView, { sectionCount, directoryCount }: { sectionCount: number; directoryCount: number }): number {
  view.setUint16(0, 0x5a4d, true); // "MZ"
  view.setUint32(0x3c, PE_HEADER_OFFSET, true); // e_lfanew
  view.setUint32(PE_HEADER_OFFSET, 0x00004550, true); // "PE\0\0"
  const coff = PE_HEADER_OFFSET + 4;
  view.setUint16(coff, 0x8664, true); // machine x64
  view.setUint16(coff + 2, sectionCount, true);
  view.setUint16(coff + 16, OPTIONAL_HEADER_BYTES, true); // SizeOfOptionalHeader
  view.setUint16(coff + 18, 0x2000, true); // characteristics: DLL
  const optionalHeader = coff + 20;
  view.setUint16(optionalHeader, 0x20b, true); // PE32+ magic
  view.setUint32(optionalHeader + 56, 0x2000, true); // SizeOfImage
  view.setUint32(optionalHeader + 108, directoryCount, true); // NumberOfRvaAndSizes
  return optionalHeader;
}

/** Data directory 2 (resources) and the section table: one .rsrc section at RESOURCE_RVA. */
function writeResourceSection(view: DataView, optionalHeader: number): void {
  const directories = optionalHeader + 112;
  view.setUint32(directories + 2 * 8, RESOURCE_RVA, true); // data directory[2] = resource RVA
  view.setUint32(directories + 2 * 8 + 4, 0x200, true); // resource size
  const section = optionalHeader + OPTIONAL_HEADER_BYTES;
  const name = ".rsrc";
  for (let i = 0; i < name.length; i++) view.setUint8(section + i, name.charCodeAt(i));
  view.setUint32(section + 8, 0x200, true); // VirtualSize
  view.setUint32(section + 12, RESOURCE_RVA, true); // VirtualAddress
  view.setUint32(section + 16, 0x200, true); // SizeOfRawData
  view.setUint32(section + 20, RESOURCE_RVA, true); // PointerToRawData
}

/** The RT_VERSION resource tree, offsets relative to RESOURCE_RVA; returns the RVA of the version blob it names. */
function writeResourceTree(view: DataView): number {
  // The high bit of an entry's offset marks a subdirectory.
  const SUB = 0x80000000;
  // Level 1: type directory, one id entry (RT_VERSION = 16)
  view.setUint16(RESOURCE_RVA + 14, 1, true); // NumberOfIdEntries
  view.setUint32(RESOURCE_RVA + 16, 16, true); // Id = RT_VERSION
  view.setUint32(RESOURCE_RVA + 20, SUB | 0x18, true);
  // Level 2: name directory, one entry
  view.setUint16(RESOURCE_RVA + 0x18 + 14, 1, true);
  view.setUint32(RESOURCE_RVA + 0x28, 1, true);
  view.setUint32(RESOURCE_RVA + 0x2c, SUB | 0x30, true);
  // Level 3: language directory, one entry -> data entry (high bit clear)
  view.setUint16(RESOURCE_RVA + 0x30 + 14, 1, true);
  view.setUint32(RESOURCE_RVA + 0x40, 0x409, true);
  view.setUint32(RESOURCE_RVA + 0x44, 0x48, true);
  // Data entry: OffsetToData(RVA), Size
  const blobRva = RESOURCE_RVA + 0x60;
  view.setUint32(RESOURCE_RVA + 0x48, blobRva, true);
  view.setUint32(RESOURCE_RVA + 0x4c, 0x80, true); // blob size
  return blobRva;
}

/**
 * The version blob: a false-positive FixedFileInfo signature, the real FixedFileInfo with a product version
 * distinct from the file version, and a StringFileInfo "FileVersion" display string.
 */
function writeVersionBlob(view: DataView, blobRva: number): void {
  view.setUint32(blobRva, 0xfeef04bd, true);
  view.setUint32(blobRva + 4, 0xdeadbeef, true); // NOT strucVersion -> skipped
  const fix = blobRva + 16;
  view.setUint32(fix, 0xfeef04bd, true);
  view.setUint32(fix + 4, 0x00010000, true); // dwStrucVersion
  view.setUint32(fix + 8, 0x01360007, true); // fileVersionMS -> 310.7
  view.setUint32(fix + 12, 0x00810000, true); // fileVersionLS -> 129.0
  view.setUint32(fix + 16, 0x01360007, true); // productVersionMS -> 310.7
  view.setUint32(fix + 20, 0x00000000, true); // productVersionLS -> 0.0

  // "FileVersion" = "310.7.SF.0" (UTF-16LE), 4-aligned to the blob
  const keyOff = blobRva + 64;
  const key = "FileVersion";
  for (let i = 0; i < key.length; i++) view.setUint16(keyOff + i * 2, key.charCodeAt(i), true);
  const valOff = keyOff + (key.length + 1) * 2; // past the key's null wchar
  const val = "310.7.SF.0";
  for (let i = 0; i < val.length; i++) view.setUint16(valOff + i * 2, val.charCodeAt(i), true);
}

/**
 * Build a minimal PE32+ file whose only resource is an RT_VERSION blob. The
 * blob deliberately starts with a FixedFileInfo signature that is NOT followed
 * by dwStrucVersion (a false positive) before the real one, and encodes a
 * product version distinct from the file version, plus a StringFileInfo
 * "FileVersion" display string. Section RVA == raw pointer so RVAs are offsets.
 */
function buildSyntheticPe(): Uint8Array {
  const view = new DataView(new ArrayBuffer(0x1100));
  const optionalHeader = writePeShell(view, { sectionCount: 1, directoryCount: 16 });
  writeResourceSection(view, optionalHeader);
  writeVersionBlob(view, writeResourceTree(view));
  return new Uint8Array(view.buffer);
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
  writePeShell(new DataView(shell.buffer), { sectionCount: 0, directoryCount: 0 });
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

test("buildRuntimeCatalog reads a DLL's version again once the file changes", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "catalog-cache-"));
  const dll = join(runtimeDir, "dlss", "nvngx_dlss.dll");
  const srVersion = () => buildRuntimeCatalog(runtimeDir, join(runtimeDir, "no-swapper")).features.find((f) => f.key === "sr")!.versions[0]!.version;
  try {
    mkdirSync(dirname(dll), { recursive: true });
    const original = buildSyntheticPe();
    writeFileSync(dll, original);
    expect(srVersion()).toBe("310.7.129.0");
    expect(srVersion()).toBe("310.7.129.0");

    // A newer build: one byte longer, with fileVersionLS (the synthetic blob's FixedFileInfo + 12) raised to 130.0.
    const newer = new Uint8Array(original.length + 1);
    newer.set(original);
    new DataView(newer.buffer).setUint32(RESOURCE_RVA + 0x60 + 16 + 12, 0x00820000, true);
    writeFileSync(dll, newer);

    expect(srVersion()).toBe("310.7.130.0");
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("buildRuntimeCatalog is total and returns all four features", () => {
  // Guarded fs access: a bogus dir yields empty version lists, never throws.
  const empty = buildRuntimeCatalog("W:/definitely/not/here", "W:/also/not/here");
  expect(empty.features.map((f) => f.id)).toEqual([1, 11, 13, 18]);
  for (const f of empty.features) expect(f.versions).toEqual([]);
});

// runtime/ is not in git, so these run only where the bundled nvngx_dlss.dll is installed.
const hasRealDll = existsSync(REAL_DLSS);
test.if(hasRealDll)("readVersionInfo reads a 310.x version from the real nvngx_dlss.dll", async () => {
  const info = await readVersionInfo(REAL_DLSS);
  expect(info.fileVersion).toMatch(/^310\.\d+\.\d+\.\d+$/);
});

test.if(hasRealDll)("buildRuntimeCatalog lists the bundled SR DLL as installed, with its 310.x version", () => {
  // An empty DLSS Swapper cache, so the machine's own installs do not join the catalog.
  const manifest = buildRuntimeCatalog(DEFAULT_RUNTIME_DIR, join(tmpdir(), "no-swapper-cache"));
  const sr = manifest.features.find((f) => f.id === 1)!;
  expect(sr.dllName).toBe("nvngx_dlss.dll");
  const bundled = sr.versions.find((entry) => entry.path === REAL_DLSS);
  expect(bundled?.source).toBe("installed");
  expect(bundled?.version).toMatch(/^310\./);
  expect(bundled?.sizeMB).toBeGreaterThan(0);
});
