/**
 * One canonical serialisation, and the digests taken over it.
 *
 * Canonical means object keys in sorted order and `undefined` members dropped, so a value whose
 * fields are written in another order serialises the same and a value whose content changed does
 * not.
 *
 * COUPLED: `host.ts`'s `moduleDigest` hashes this form, and the digests recorded in
 * `services/zz-core/src/reviewed-modules.ts` were computed from it. Changing what it emits changes
 * every one of them.
 */
import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A short digest of a value's canonical form: the first 32 hex characters of its sha-256. */
export const stableDigest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);
