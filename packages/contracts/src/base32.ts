/**
 * RFC 4648 base32, lowercase and unpadded — the one encoder every opaque token on the platform is
 * minted with: a content revision, a details reference and its cursor, an upload id and its link
 * secret.
 *
 * A leaf module: `index.ts` re-exports it and `upload-text.ts` imports it, so neither reaches the
 * other through the index.
 */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded, the final partial group included. */
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** `base32` read back to its bytes, or null for a character outside the alphabet. */
export function unbase32(s: string): Buffer | null {
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of s) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
