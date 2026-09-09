/**
 * Reads the VS_VERSION_INFO resource out of a PE file (DLL / EXE) without loading
 * it, so the runtime catalog can version an NGX DLL by static inspection alone.
 *
 * The numeric FixedFileInfo is the canonical version — DLSS Swapper names its
 * folders from it — while the optional StringFileInfo string may carry a
 * non-numeric label (e.g. "310.8.SF.0") that is only good for display.
 */
import { parsePe, type PeSection } from "./pe.ts";

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
const NULL_VERSION: VersionInfo = { fileVersion: null, productVersion: null, stringFileVersion: null };

/** Map an RVA to a file offset using the section table (same rule as pe.ts). */
function makeRvaToOffset(sections: PeSection[]): (rva: number) => number {
  return (rva: number): number => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        return section.rawPointer + (rva - section.virtualAddress);
      }
    }
    if (rva < (sections[0]?.rawPointer ?? 0)) return rva; // inside the headers
    throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  };
}

/** Format one packed dword (MS or LS) as "high.low". */
function fmtWord(word: number): string {
  return `${word >>> 16}.${word & 0xffff}`;
}

/**
 * Locate the first RT_VERSION resource leaf and return its file offset + size,
 * or null when the file has no resource section / version resource.
 */
function findVersionBlob(view: DataView, sections: PeSection[]): { offset: number; size: number } | null {
  const peOff = view.getUint32(0x3c, true);
  const coff = peOff + 4;
  const optional = coff + 20;
  const magic = view.getUint16(optional, true);
  const is64 = magic === 0x20b;
  const directoryCount = view.getUint32(optional + (is64 ? 108 : 92), true);
  if (directoryCount < 3) return null; // no resource data directory (index 2)
  const directoriesOffset = optional + (is64 ? 112 : 96);
  const resourceRva = view.getUint32(directoriesOffset + 2 * 8, true);
  const resourceSize = view.getUint32(directoriesOffset + 2 * 8 + 4, true);
  if (resourceRva === 0 || resourceSize === 0) return null;

  const rvaToOffset = makeRvaToOffset(sections);
  const resourceBase = rvaToOffset(resourceRva);

  // Each IMAGE_RESOURCE_DIRECTORY is a 16-byte header followed by 8-byte
  // entries: named entries first, then id entries. Entry = {name/id u32, offset u32}.
  const findEntry = (dirOffset: number, wantId: number | null): number | null => {
    const namedCount = view.getUint16(dirOffset + 12, true);
    const idCount = view.getUint16(dirOffset + 14, true);
    const entriesStart = dirOffset + 16;
    const total = namedCount + idCount;
    for (let i = 0; i < total; i++) {
      const entry = entriesStart + i * 8;
      const nameField = view.getUint32(entry, true);
      const offsetField = view.getUint32(entry + 4, true);
      if (wantId === null) return offsetField; // first entry (name / language level)
      const isNamed = (nameField & SUBDIR_FLAG) !== 0;
      if (!isNamed && nameField === wantId) return offsetField;
    }
    return null;
  };

  // type(RT_VERSION) -> name -> language -> data entry (three subdirectory hops).
  const typeOffset = findEntry(resourceBase, RT_VERSION);
  if (typeOffset === null || (typeOffset & SUBDIR_FLAG) === 0) return null;
  const nameOffset = findEntry(resourceBase + (typeOffset & ~SUBDIR_FLAG), null);
  if (nameOffset === null || (nameOffset & SUBDIR_FLAG) === 0) return null;
  const langOffset = findEntry(resourceBase + (nameOffset & ~SUBDIR_FLAG), null);
  if (langOffset === null) return null;

  // Leaf is an IMAGE_RESOURCE_DATA_ENTRY {OffsetToData(RVA) u32, Size u32, ...};
  // its high bit is clear at this level.
  const leaf = resourceBase + (langOffset & ~SUBDIR_FLAG);
  const blobRva = view.getUint32(leaf, true);
  const blobSize = view.getUint32(leaf + 4, true);
  if (blobSize === 0) return null;
  return { offset: rvaToOffset(blobRva), size: blobSize };
}

/**
 * Scan the (already located) version blob for the StringFileInfo child named
 * `key` and return its UTF-16LE value. Display-only; returns null on any miss.
 */
function readStringValue(bytes: Uint8Array, blobStart: number, blobEnd: number, key: string): string | null {
  try {
    // UTF-16LE bytes of the key (ASCII keys only).
    const needle = new Uint8Array(key.length * 2);
    for (let i = 0; i < key.length; i++) needle[i * 2] = key.charCodeAt(i) & 0xff;
    const limit = Math.min(blobEnd, bytes.length);
    for (let p = blobStart; p + needle.length <= limit; p += 2) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (bytes[p + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
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
  } catch {
    // fall through
  }
  return null;
}

/**
 * Parse the VS_VERSION_INFO resource from PE bytes already in memory. Never
 * throws: any structural problem yields nulls so callers can render "-".
 */
export function parseVersionInfo(bytes: Uint8Array): VersionInfo {
  try {
    if (bytes.length < 0x40) return NULL_VERSION;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { sections } = parsePe(bytes);
    const blob = findVersionBlob(view, sections);
    if (!blob) return NULL_VERSION;

    const blobEnd = Math.min(blob.offset + blob.size, bytes.length);
    // The 0xFEEF04BD signature alone matches unrelated bytes elsewhere in a DLL,
    // so require dwStrucVersion == 0x00010000 right behind it and stay inside the
    // located blob.
    for (let p = blob.offset; p + 24 <= blobEnd; p += 4) {
      if (view.getUint32(p, true) === FIXED_FILE_INFO_SIGNATURE && view.getUint32(p + 4, true) === STRUC_VERSION) {
        const fileVersion = `${fmtWord(view.getUint32(p + 8, true))}.${fmtWord(view.getUint32(p + 12, true))}`;
        const productVersion = `${fmtWord(view.getUint32(p + 16, true))}.${fmtWord(view.getUint32(p + 20, true))}`;
        const stringFileVersion = readStringValue(bytes, blob.offset, blobEnd, "FileVersion");
        return { fileVersion, productVersion, stringFileVersion };
      }
    }
  } catch {
    // fall through to nulls
  }
  return NULL_VERSION;
}

/** Read and parse the VS_VERSION_INFO resource of a PE file at `path`. */
export async function readVersionInfo(path: string): Promise<VersionInfo> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return parseVersionInfo(bytes);
}
