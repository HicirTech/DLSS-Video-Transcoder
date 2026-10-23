/**
 * Writes the generated nvngx.dll shim to disk once per content, coalescing concurrent writes in this process and
 * leaving in place a shim another process has loaded.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { buildForwarderDll } from "./forwarder.ts";

/** What became of the shim on disk: "kept-loaded" means an older copy stays because a process has it loaded. */
export type ShimWrite = "written" | "unchanged" | "kept-loaded";

export interface ShimWriteResult {
  path: string;
  status: ShimWrite;
  size: number;
}

const inflightWrites = new Map<string, Promise<ShimWriteResult>>();
let tempSequence = 0;

/**
 * Whether `error`, from replacing the shim at `path`, means Windows would not touch a DLL that a
 * process has mapped (EBUSY, EPERM or EACCES; with a loaded shim a rename over it failed with EPERM
 * and a write into it with EBUSY, on Windows 11 with Bun 1.4.2). The shim in place exports the same
 * four functions (an emission from before the unwind data only lacks it), so the run keeps it
 * instead of failing and the new one is written once nothing has the old one loaded. Any other
 * error is real.
 */
function keepsLoadedShim(error: unknown, path: string): boolean {
  const code = (error as { code?: string }).code;
  return (code === "EBUSY" || code === "EPERM" || code === "EACCES") && existsSync(path);
}

/** The temp file is gone after a rename and a leftover one is harmless, so a failed removal is ignored. */
function removeTempFile(tmp: string): void {
  try { unlinkSync(tmp); } catch { /* ignore */ }
}

function isCurrentShim(current: Uint8Array, built: Uint8Array): boolean {
  return current.length === built.length && current.every((byte, index) => byte === built[index]);
}

/**
 * Write the shim to `path` unless an identical file is already there. Concurrent writes to the same path in this
 * process are coalesced (two first-run `/api/probe` requests would otherwise both write it), and the write goes
 * through a temp file + rename so a concurrent loader sees the old shim or the new one. Only when Windows refuses
 * that rename (the destination is held open) is the shim written in place, and that write is not atomic. A shim
 * that is loaded stays as it is ("kept-loaded", keepsLoadedShim).
 */
export function writeForwarder(path: string): Promise<ShimWriteResult> {
  const existing = inflightWrites.get(path);
  if (existing) return existing;
  const pendingWrite = doWriteForwarder(path).finally(() => inflightWrites.delete(path));
  inflightWrites.set(path, pendingWrite);
  return pendingWrite;
}

async function doWriteForwarder(path: string): Promise<ShimWriteResult> {
  const built = buildForwarderDll();
  const existing = Bun.file(path);
  if ((await existing.exists()) && isCurrentShim(new Uint8Array(await existing.arrayBuffer()), built.bytes)) {
    return { path, status: "unchanged", size: built.bytes.length };
  }
  const tmp = `${path}.tmp.${process.pid}.${tempSequence++}`;
  try {
    await Bun.write(tmp, built.bytes);
    return { path, status: await replaceShim(tmp, path, built.bytes), size: built.bytes.length };
  } finally {
    removeTempFile(tmp);
  }
}

/** Puts `bytes` at `path` by renaming `tmp` over it; "kept-loaded" when keepsLoadedShim left the shim there. */
async function replaceShim(tmp: string, path: string, bytes: Uint8Array): Promise<ShimWrite> {
  try {
    try {
      await rename(tmp, path); // atomic: a loader sees the old file or the new one
    } catch {
      await Bun.write(path, bytes); // not atomic; used only when Windows refuses the rename because the destination is held open
    }
    return "written";
  } catch (error) {
    if (keepsLoadedShim(error, path)) return "kept-loaded";
    throw error;
  }
}

/** Synchronous sibling of writeForwarder, for callers that cannot await (engine factories). */
export function writeForwarderSync(path: string): ShimWriteResult {
  const built = buildForwarderDll();
  if (existsSync(path) && isCurrentShim(readFileSync(path), built.bytes)) {
    return { path, status: "unchanged", size: built.bytes.length };
  }
  const tmp = `${path}.tmp.${process.pid}.${tempSequence++}`;
  try {
    writeFileSync(tmp, built.bytes);
    return { path, status: replaceShimSync(tmp, path, built.bytes), size: built.bytes.length };
  } finally {
    removeTempFile(tmp);
  }
}

/** Synchronous sibling of replaceShim. */
function replaceShimSync(tmp: string, path: string, bytes: Uint8Array): ShimWrite {
  try {
    try {
      renameSync(tmp, path); // atomic: a loader sees the old file or the new one
    } catch {
      writeFileSync(path, bytes); // not atomic; used only when Windows refuses the rename because the destination is held open
    }
    return "written";
  } catch (error) {
    if (keepsLoadedShim(error, path)) return "kept-loaded";
    throw error;
  }
}
