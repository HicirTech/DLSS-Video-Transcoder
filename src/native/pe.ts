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

export interface PeInfo {
  machine: number;
  is64: boolean;
  isDll: boolean;
  imageBase: bigint;
  sizeOfImage: number;
  entryPoint: number;
  sections: PeSection[];
  exports: PeExport[];
}

const IMAGE_FILE_DLL = 0x2000;

function readAscii(bytes: Uint8Array, offset: number, maxLength: number): string {
  let end = offset;
  const limit = Math.min(bytes.length, offset + maxLength);
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder("latin1").decode(bytes.subarray(offset, end));
}

/** Parse headers and the export directory of a PE file already loaded into memory. */
export function parsePe(bytes: Uint8Array): PeInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) throw new Error("Not a PE file: missing MZ header");
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 24 > bytes.length || view.getUint32(peOffset, true) !== 0x00004550) {
    throw new Error("Not a PE file: missing PE signature");
  }
  const coff = peOffset + 4;
  const machine = view.getUint16(coff, true);
  const sectionCount = view.getUint16(coff + 2, true);
  const optionalSize = view.getUint16(coff + 16, true);
  const characteristics = view.getUint16(coff + 18, true);
  const optional = coff + 20;
  const magic = view.getUint16(optional, true);
  const is64 = magic === 0x20b;
  if (!is64 && magic !== 0x10b) throw new Error(`Unknown optional header magic 0x${magic.toString(16)}`);

  const entryPoint = view.getUint32(optional + 16, true);
  const imageBase = is64 ? view.getBigUint64(optional + 24, true) : BigInt(view.getUint32(optional + 28, true));
  const sizeOfImage = view.getUint32(optional + 56, true);
  const directoriesOffset = optional + (is64 ? 112 : 96);
  const directoryCount = view.getUint32(optional + (is64 ? 108 : 92), true);

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

  const rvaToOffset = (rva: number): number => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        return section.rawPointer + (rva - section.virtualAddress);
      }
    }
    if (rva < (sections[0]?.rawPointer ?? 0)) return rva; // inside the headers
    throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  };

  const exports: PeExport[] = [];
  if (directoryCount > 0) {
    const exportRva = view.getUint32(directoriesOffset, true);
    const exportSize = view.getUint32(directoriesOffset + 4, true);
    if (exportRva !== 0 && exportSize !== 0) {
      const dir = rvaToOffset(exportRva);
      const ordinalBase = view.getUint32(dir + 16, true);
      const functionCount = view.getUint32(dir + 20, true);
      const nameCount = view.getUint32(dir + 24, true);
      const functionsOffset = rvaToOffset(view.getUint32(dir + 28, true));
      const namesOffset = rvaToOffset(view.getUint32(dir + 32, true));
      const ordinalsOffset = rvaToOffset(view.getUint32(dir + 36, true));
      const named = new Map<number, string>();
      for (let i = 0; i < nameCount; i++) {
        const nameRva = view.getUint32(namesOffset + i * 4, true);
        const ordinalIndex = view.getUint16(ordinalsOffset + i * 2, true);
        named.set(ordinalIndex, readAscii(bytes, rvaToOffset(nameRva), 4096));
      }
      for (let i = 0; i < functionCount; i++) {
        const rva = view.getUint32(functionsOffset + i * 4, true);
        if (rva === 0) continue;
        const forwarder = rva >= exportRva && rva < exportRva + exportSize ? readAscii(bytes, rvaToOffset(rva), 512) : null;
        exports.push({ name: named.get(i) ?? `#${ordinalBase + i}`, ordinal: ordinalBase + i, rva, forwarder });
      }
    }
  }
  exports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    machine,
    is64,
    isDll: (characteristics & IMAGE_FILE_DLL) !== 0,
    imageBase,
    sizeOfImage,
    entryPoint,
    sections,
    exports,
  };
}

export async function readPeFile(path: string): Promise<PeInfo> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return parsePe(bytes);
}

export async function listExports(path: string): Promise<string[]> {
  return (await readPeFile(path)).exports.map((entry) => entry.name);
}
