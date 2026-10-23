/**
 * Reads the VS_VERSION_INFO resource out of a PE file (DLL / EXE) without loading
 * it, so the runtime catalog can version an NGX DLL by static inspection alone.
 *
 * The numeric FixedFileInfo is the canonical version — DLSS Swapper names its
 * folders from it — while the optional StringFileInfo string may carry a
 * non-numeric label (e.g. "310.8.SF.0") that is only good for display.
 */
import { parsePe, rvaToOffset, type PeInfo } from "./pe.ts";

export interface VersionInfo {
  /** Numeric FixedFileInfo file version, "a.b.c.d", or null if not found. */
  fileVersion: string | null;
  /** Numeric FixedFileInfo product version, "a.b.c.d", or null if not found. */
  productVersion: string | null;
  /** StringFileInfo "FileVersion" as written for display (may be non-numeric), or null. */
  stringFileVersion: string | null;
}

const RT_VERSION = 16;
const FIXED_FILE_INFO_SIGNATURE = 0xfeef04bd;
const STRUC_VERSION = 0x00010000;
const SUBDIR_FLAG = 0x80000000;
const RESOURCE_DIRECTORY_INDEX = 2;
const NULL_VERSION: VersionInfo = { fileVersion: null, productVersion: null, stringFileVersion: null };

/** Format one packed dword (MS or LS) as "high.low". */
function formatVersionWord(word: number): string {
  return `${word >>> 16}.${word & 0xffff}`;
}

// Each IMAGE_RESOURCE_DIRECTORY (winnt.h) is a 16-byte header, holding the named and id entry counts at +12 and +14,
// followed by 8-byte entries {name/id u32, offset u32}: named entries first, then id entries.

/** The offset field of the id entry `id` in the resource directory at `directoryOffset`, or null. */
function findEntryById(view: DataView, directoryOffset: number, id: number): number | null {
  const total = view.getUint16(directoryOffset + 12, true) + view.getUint16(directoryOffset + 14, true);
  for (let i = 0; i < total; i++) {
    const entry = directoryOffset + 16 + i * 8;
    const nameField = view.getUint32(entry, true);
    if ((nameField & SUBDIR_FLAG) === 0 && nameField === id) return view.getUint32(entry + 4, true);
  }
  return null;
}

/** The offset field of the first entry of the resource directory at `directoryOffset`, or null when it is empty. */
function firstEntryOffset(view: DataView, directoryOffset: number): number | null {
  const total = view.getUint16(directoryOffset + 12, true) + view.getUint16(directoryOffset + 14, true);
  return total > 0 ? view.getUint32(directoryOffset + 16 + 4, true) : null;
}

/** The blob an IMAGE_RESOURCE_DATA_ENTRY (winnt.h) {OffsetToData(RVA) u32, Size u32, ...} points at, or null when empty. */
function readDataEntry(view: DataView, leafOffset: number, pe: PeInfo): { offset: number; size: number } | null {
  const blobRva = view.getUint32(leafOffset, true);
  const blobSize = view.getUint32(leafOffset + 4, true);
  if (blobSize === 0) return null;
  return { offset: rvaToOffset(pe.sections, blobRva), size: blobSize };
}

/**
 * Locate the first RT_VERSION resource leaf and return its file offset + size,
 * or null when the file has no resource section / version resource.
 */
function findVersionBlob(view: DataView, pe: PeInfo): { offset: number; size: number } | null {
  const resources = pe.dataDirectories[RESOURCE_DIRECTORY_INDEX];
  if (!resources || resources.rva === 0 || resources.size === 0) return null;
  const resourceBase = rvaToOffset(pe.sections, resources.rva);

  // type(RT_VERSION) -> name -> language -> data entry (three subdirectory hops).
  const typeOffset = findEntryById(view, resourceBase, RT_VERSION);
  if (typeOffset === null || (typeOffset & SUBDIR_FLAG) === 0) return null;
  const nameOffset = firstEntryOffset(view, resourceBase + (typeOffset & ~SUBDIR_FLAG));
  if (nameOffset === null || (nameOffset & SUBDIR_FLAG) === 0) return null;
  const languageOffset = firstEntryOffset(view, resourceBase + (nameOffset & ~SUBDIR_FLAG));
  if (languageOffset === null) return null;
  // The data entry's high bit is clear at this level.
  return readDataEntry(view, resourceBase + (languageOffset & ~SUBDIR_FLAG), pe);
}

/** True when `bytes` holds `needle` at `offset`. */
function matchesAt(bytes: Uint8Array, offset: number, needle: Uint8Array): boolean {
  for (let j = 0; j < needle.length; j++) {
    if (bytes[offset + j] !== needle[j]) return false;
  }
  return true;
}

/**
 * Scan the (already located) version blob for the StringFileInfo child named
 * `key` and return its UTF-16LE value. Display-only; returns null on any miss.
 */
function readStringValue(bytes: Uint8Array, blobStart: number, blobEnd: number, key: string): string | null {
  // UTF-16LE bytes of the key (ASCII keys only).
  const needle = new Uint8Array(key.length * 2);
  for (let i = 0; i < key.length; i++) needle[i * 2] = key.charCodeAt(i) & 0xff;
  const limit = Math.min(blobEnd, bytes.length);
  for (let p = blobStart; p + needle.length <= limit; p += 2) {
    if (!matchesAt(bytes, p, needle)) continue;
    // Advance past the key and its terminating null wchar, then pad to a
    // 32-bit boundary relative to the blob start, then read the value wchars.
    let q = p + needle.length;
    if (q + 1 < limit && bytes[q] === 0 && bytes[q + 1] === 0) q += 2;
    while ((q - blobStart) % 4 !== 0) q += 2;
    let value = "";
    while (q + 1 < limit) {
      const ch = bytes[q]! | (bytes[q + 1]! << 8);
      if (ch === 0) break;
      value += String.fromCharCode(ch);
      q += 2;
    }
    value = value.trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Parse the VS_VERSION_INFO resource from PE bytes already in memory. Never
 * throws: any structural problem yields nulls so callers can render "-".
 */
export function parseVersionInfo(bytes: Uint8Array): VersionInfo {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blob = findVersionBlob(view, parsePe(bytes));
    if (!blob) return NULL_VERSION;

    const blobEnd = Math.min(blob.offset + blob.size, bytes.length);
    // The 0xFEEF04BD signature alone matches unrelated bytes elsewhere in a DLL,
    // so require dwStrucVersion == 0x00010000 right behind it and stay inside the
    // located blob.
    for (let p = blob.offset; p + 24 <= blobEnd; p += 4) {
      if (view.getUint32(p, true) === FIXED_FILE_INFO_SIGNATURE && view.getUint32(p + 4, true) === STRUC_VERSION) {
        const fileVersion = `${formatVersionWord(view.getUint32(p + 8, true))}.${formatVersionWord(view.getUint32(p + 12, true))}`;
        const productVersion = `${formatVersionWord(view.getUint32(p + 16, true))}.${formatVersionWord(view.getUint32(p + 20, true))}`;
        const stringFileVersion = readStringValue(bytes, blob.offset, blobEnd, "FileVersion");
        return { fileVersion, productVersion, stringFileVersion };
      }
    }
  } catch {
    // parsePe, rvaToOffset and out-of-range DataView reads throw on a malformed image: nulls, as for no resource.
  }
  return NULL_VERSION;
}

/** Read and parse the VS_VERSION_INFO resource of a PE file at `path`. */
export async function readVersionInfo(path: string): Promise<VersionInfo> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return parseVersionInfo(bytes);
}
