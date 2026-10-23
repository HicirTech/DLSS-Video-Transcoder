/**
 * Minimal Portable Executable reader: enough to list the exports of a DLL
 * without loading it, which lets the probe report what an NGX runtime offers
 * before any code from it runs.
 */

export interface PeExport {
  name: string;
  ordinal: number;
  rva: number;
  /** Set when the export forwards to "OtherDll.Function" instead of pointing at code. */
  forwarder: string | null;
}

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawPointer: number;
  rawSize: number;
  characteristics: number;
}

/** One IMAGE_DATA_DIRECTORY: where a table such as the exports or the resources lives; rva 0 means it is absent. */
export interface PeDataDirectory {
  rva: number;
  size: number;
}

export interface PeInfo {
  machine: number;
  is64: boolean;
  isDll: boolean;
  imageBase: bigint;
  sizeOfImage: number;
  entryPoint: number;
  /** IMAGE_OPTIONAL_HEADER's DataDirectory[], indexed by IMAGE_DIRECTORY_ENTRY_* (export 0, resource 2, ...). */
  dataDirectories: PeDataDirectory[];
  sections: PeSection[];
  exports: PeExport[];
}

// winnt.h
export const IMAGE_DOS_SIGNATURE = 0x5a4d; // "MZ"
export const IMAGE_NT_SIGNATURE = 0x00004550; // "PE\0\0"
export const IMAGE_NT_OPTIONAL_HDR32_MAGIC = 0x10b;
export const IMAGE_NT_OPTIONAL_HDR64_MAGIC = 0x20b;
const E_LFANEW_OFFSET = 0x3c; // IMAGE_DOS_HEADER.e_lfanew: the file offset of the NT headers
const IMAGE_FILE_DLL = 0x2000;
const IMAGE_NUMBEROF_DIRECTORY_ENTRIES = 16;
const IMAGE_DIRECTORY_ENTRY_EXPORT = 0;

function readAscii(bytes: Uint8Array, offset: number, maxLength: number): string {
  let end = offset;
  const limit = Math.min(bytes.length, offset + maxLength);
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder("latin1").decode(bytes.subarray(offset, end));
}

/** The file offset of an RVA, through the section that maps it; an RVA below the first section lies in the headers. */
export function rvaToOffset(sections: readonly PeSection[], rva: number): number {
  for (const section of sections) {
    const size = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
      return section.rawPointer + (rva - section.virtualAddress);
    }
  }
  if (rva < (sections[0]?.rawPointer ?? 0)) return rva;
  throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
}

/** The export table, or none when its data directory is empty. Every name a function is exported under is listed. */
function readExports(bytes: Uint8Array, view: DataView, directory: PeDataDirectory, toOffset: (rva: number) => number): PeExport[] {
  if (directory.rva === 0 || directory.size === 0) return [];
  // IMAGE_EXPORT_DIRECTORY (winnt.h): Base @16, NumberOfFunctions @20, NumberOfNames @24, AddressOfFunctions @28,
  // AddressOfNames @32, AddressOfNameOrdinals @36.
  const exportDirectory = toOffset(directory.rva);
  const ordinalBase = view.getUint32(exportDirectory + 16, true);
  const functionCount = view.getUint32(exportDirectory + 20, true);
  const nameCount = view.getUint32(exportDirectory + 24, true);
  const functionsOffset = toOffset(view.getUint32(exportDirectory + 28, true));
  const namesOffset = toOffset(view.getUint32(exportDirectory + 32, true));
  const ordinalsOffset = toOffset(view.getUint32(exportDirectory + 36, true));
  const namesByIndex = new Map<number, string[]>();
  for (let i = 0; i < nameCount; i++) {
    const nameRva = view.getUint32(namesOffset + i * 4, true);
    const ordinalIndex = view.getUint16(ordinalsOffset + i * 2, true);
    const name = readAscii(bytes, toOffset(nameRva), 4096);
    const aliases = namesByIndex.get(ordinalIndex);
    if (aliases) aliases.push(name);
    else namesByIndex.set(ordinalIndex, [name]);
  }
  const exports: PeExport[] = [];
  for (let i = 0; i < functionCount; i++) {
    const rva = view.getUint32(functionsOffset + i * 4, true);
    if (rva === 0) continue;
    // PE spec: an export RVA pointing back inside the export directory is a
    // forwarder string ("OtherDll.Function"), not the address of code.
    const forwarder = rva >= directory.rva && rva < directory.rva + directory.size ? readAscii(bytes, toOffset(rva), 512) : null;
    for (const name of namesByIndex.get(i) ?? [`#${ordinalBase + i}`]) exports.push({ name, ordinal: ordinalBase + i, rva, forwarder });
  }
  return exports;
}

/** Parse headers and the export directory of a PE file already loaded into memory. */
export function parsePe(bytes: Uint8Array): PeInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x40 || view.getUint16(0, true) !== IMAGE_DOS_SIGNATURE) throw new Error("Not a PE file: missing MZ header");
  const peOffset = view.getUint32(E_LFANEW_OFFSET, true);
  if (peOffset + 24 > bytes.length || view.getUint32(peOffset, true) !== IMAGE_NT_SIGNATURE) {
    throw new Error("Not a PE file: missing PE signature");
  }
  const coff = peOffset + 4;
  const machine = view.getUint16(coff, true);
  const sectionCount = view.getUint16(coff + 2, true);
  const optionalSize = view.getUint16(coff + 16, true);
  const characteristics = view.getUint16(coff + 18, true);
  const optional = coff + 20;
  const magic = view.getUint16(optional, true);
  const is64 = magic === IMAGE_NT_OPTIONAL_HDR64_MAGIC;
  if (!is64 && magic !== IMAGE_NT_OPTIONAL_HDR32_MAGIC) throw new Error(`Unknown optional header magic 0x${magic.toString(16)}`);

  const entryPoint = view.getUint32(optional + 16, true);
  const imageBase = is64 ? view.getBigUint64(optional + 24, true) : BigInt(view.getUint32(optional + 28, true));
  const sizeOfImage = view.getUint32(optional + 56, true);
  const directoriesOffset = optional + (is64 ? 112 : 96);
  const directoryCount = view.getUint32(optional + (is64 ? 108 : 92), true);
  const dataDirectories: PeDataDirectory[] = [];
  for (let i = 0; i < Math.min(directoryCount, IMAGE_NUMBEROF_DIRECTORY_ENTRIES); i++) {
    dataDirectories.push({ rva: view.getUint32(directoriesOffset + i * 8, true), size: view.getUint32(directoriesOffset + i * 8 + 4, true) });
  }

  const sections: PeSection[] = [];
  let sectionOffset = optional + optionalSize;
  for (let i = 0; i < sectionCount; i++, sectionOffset += 40) {
    sections.push({
      name: readAscii(bytes, sectionOffset, 8),
      virtualSize: view.getUint32(sectionOffset + 8, true),
      virtualAddress: view.getUint32(sectionOffset + 12, true),
      rawSize: view.getUint32(sectionOffset + 16, true),
      rawPointer: view.getUint32(sectionOffset + 20, true),
      characteristics: view.getUint32(sectionOffset + 36, true),
    });
  }

  const exportDirectory = dataDirectories[IMAGE_DIRECTORY_ENTRY_EXPORT];
  const exports = exportDirectory ? readExports(bytes, view, exportDirectory, (rva) => rvaToOffset(sections, rva)) : [];
  exports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    machine,
    is64,
    isDll: (characteristics & IMAGE_FILE_DLL) !== 0,
    imageBase,
    sizeOfImage,
    entryPoint,
    dataDirectories,
    sections,
    exports,
  };
}
