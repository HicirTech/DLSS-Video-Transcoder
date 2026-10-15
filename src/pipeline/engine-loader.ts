/**
 * Registers an NGX engine with createEngine by importing its module. The import is lazy so a machine without
 * the NVIDIA runtime can still run a bypass job; whatever runs a job's engine loads it through here.
 */
import type { EngineKind } from "../server/api-types.ts";

export async function loadEngine(kind: EngineKind): Promise<void> {
  if (kind === "nr") await import("../ngx/nr.ts");
  else if (kind === "sr") await import("../ngx/sr-engine.ts");
}
