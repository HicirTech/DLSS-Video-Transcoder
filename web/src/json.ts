/** Narrowing for JSON read from the network or from storage, before any field of it is trusted. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
