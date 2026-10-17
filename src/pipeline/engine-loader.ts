/**
 * Registers the NGX engines a job's steps run with createEngineChain by importing their modules. Lazy, so a
 * machine without the NVIDIA runtime can still run a job without them; whatever runs a job's engines loads
 * them through here.
 */
export async function loadEngines(steps: { sr: boolean; nr: boolean }): Promise<void> {
  if (steps.sr) await import("../ngx/sr-engine.ts");
  if (steps.nr) await import("../ngx/nr.ts");
}
