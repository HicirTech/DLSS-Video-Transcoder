/** CRC-32 as PNG chunks use it: the reflected IEEE polynomial, eight input bytes per step. */

/**
 * Lookup tables for the reflected CRC-32 polynomial 0xEDB88320 (the one PNG, zlib and gzip use).
 * Table 0 is the classic byte-at-a-time table; table k is table 0 advanced by k more zero bytes, which
 * is what lets the main loop consume 8 input bytes per iteration ("slicing-by-8").
 */
const CRC_TABLES: Uint32Array = buildCrcTables();

function buildCrcTables(): Uint32Array {
  const t = new Uint32Array(8 * 256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    let c = t[i];
    for (let k = 1; k < 8; k++) {
      c = (t[c & 0xff] ^ (c >>> 8)) >>> 0;
      t[k * 256 + i] = c;
    }
  }
  return t;
}

/**
 * CRC-32 (IEEE 802.3, as used by PNG chunks) of `bytes`, as an unsigned 32-bit integer.
 *
 * `seed` is the CRC of the data that logically precedes `bytes`, so a stream can be checksummed in
 * pieces: `crc32(b, crc32(a)) === crc32(concat(a, b))`.
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  const t = CRC_TABLES;
  const n = bytes.length;
  let c = ~seed;
  let i = 0;
  const end8 = n - (n & 7);
  for (; i < end8; i += 8) {
    const w1 = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    const w2 = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    c =
      t[1792 + (w1 & 0xff)] ^
      t[1536 + ((w1 >>> 8) & 0xff)] ^
      t[1280 + ((w1 >>> 16) & 0xff)] ^
      t[1024 + (w1 >>> 24)] ^
      t[768 + (w2 & 0xff)] ^
      t[512 + ((w2 >>> 8) & 0xff)] ^
      t[256 + ((w2 >>> 16) & 0xff)] ^
      t[w2 >>> 24];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
