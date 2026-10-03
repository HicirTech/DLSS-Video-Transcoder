/**
 * A CUDA device's UUID as nvidia-smi prints it, and the pattern that recognises one. Pure, so the
 * job validation can share it with the CUDA bindings without importing them.
 */

/** Hex digits in each dash-separated group after the "GPU-" prefix. */
export const DEVICE_UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12] as const;

/** Matches exactly what formatDeviceUuid produces: lower-case hex, as nvidia-smi prints it. */
export const DEVICE_UUID_PATTERN = new RegExp(`^GPU-${DEVICE_UUID_GROUP_LENGTHS.map((length) => `[0-9a-f]{${length}}`).join("-")}$`);

/** The 16 bytes of a CUuuid as "GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx". */
export function formatDeviceUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const groups: string[] = [];
  let start = 0;
  for (const length of DEVICE_UUID_GROUP_LENGTHS) {
    groups.push(hex.slice(start, start + length));
    start += length;
  }
  return `GPU-${groups.join("-")}`;
}
