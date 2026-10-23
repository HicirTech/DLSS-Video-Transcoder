/** The probe's NGX entry and Init choices with their defaults, for the probe and the CLI help alike; no native code. */

/** The NGX module `--entry` can enter through; ProbeOptions derives its type so the two cannot drift. */
export const PROBE_ENTRIES = ["loader", "core"] as const;
export type ProbeEntry = (typeof PROBE_ENTRIES)[number];
export const DEFAULT_PROBE_ENTRY: ProbeEntry = "core";

/** The Init exports `--init` can exercise; see the branches in initializeNgx (probe.ts). */
export const PROBE_INITS = ["ext", "plain", "spy"] as const;
export type ProbeInit = (typeof PROBE_INITS)[number];
export const DEFAULT_PROBE_INIT: ProbeInit = "ext";
