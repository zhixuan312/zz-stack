/**
 * The response redactor.
 *
 * `redact(value)` walks an arbitrary structure — objects, arrays, any nesting, primitives —
 * and replaces the value of every field whose name looks like a secret with a presence
 * marker. Everything else survives unchanged. The credential and token tools were written for
 * an agent holding a PAT; this is where the line is drawn once for a browser caller instead
 * of at each call site.
 *
 * DELIBERATE: the field rule is a substring match on the name, not a list of exact names, so
 * `client_secret`, `api_key`, `token_hash` and `Authorization` are caught without being enumerated. A false positive on a field that merely mentions one of
 * the words is the intended cost. A name the rule does not recognise passes through
 * untouched, so the module's whole safety rests on `SECRET_NAME_PARTS`.
 *
 * COUPLED: `SECRET_NAME_PARTS` and `looksSecret` are exported and driven directly by
 * redact-check.ts, so the check tests this rule rather than a copy of it.
 *
 * DELIBERATE: the marker carries no prefix, suffix or any substring of the original value,
 * unlike `mask()` in packages/contracts/src/index.ts, which is the right shape for an agent
 * reading its own key back. What survives is a presence flag, a length and a SHA-256
 * fingerprint truncated to 12 hex characters — one-way, so it identifies whether a secret
 * changed without being a step towards reconstructing it.
 *
 * DELIBERATE: the one exception — a single newly-issued access token — lives in that route
 * choosing not to call this function, never in a flag or branch here. `redact()` makes no
 * exception for a field named `token`, and redact-check.ts drives that case.
 *
 * Cycles: a value already on the current path becomes "[Circular]". The `seen` set is scoped
 * to the current branch, so a value referenced from two different branches is still redacted
 * both times.
 *
 * Pure, and never throws — on null, undefined, a Date, a Buffer, a cycle, or an unrecognised
 * shape, which is walked and redacted like any other rather than returned as `{}` or refused.
 */
import { createHash } from "node:crypto";

/** Substrings whose presence in a field name (case-insensitively) marks that field's value a
 *  secret. */
export const SECRET_NAME_PARTS = [
  "token",
  "secret",
  "password",
  "key",
  "credential",
  "authorization",
  "verifier",
] as const;

/** The field rule itself, exported so redact-check.ts drives the real predicate rather than
 *  a restatement of it. */
export function looksSecret(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return SECRET_NAME_PARTS.some((part) => lower.includes(part));
}

/** What a secret-named field's value becomes: `present`, `length` and `fingerprint` are the
 *  whole of what survives, and never a prefix or echo of the value. */
export interface RedactedMarker {
  redacted: true;
  /** Whether the original value was present and non-empty. `false` for null, undefined, an
   *  empty string or an empty buffer: "no key stored" is metadata, not a secret. */
  present: boolean;
  /** The type of the redacted value, when it was neither a string nor absent. An object or
   *  array reached through a secret-named field is not walked — the name already said
   *  everything beneath it is secret-shaped. */
  type?: "object" | "array" | "number" | "boolean";
  /** String/Buffer values only: the length in characters/bytes. Confirms a stored value is
   *  the length a real key/token of that kind would be, without revealing any of it. */
  length?: number;
  /** String/Buffer values only: `sha256:` followed by the first 12 hex characters of the
   *  SHA-256 digest. One-way — lets a caller confirm "still the same secret as before" (e.g.
   *  after a rotation) without moving them any closer to the value itself. */
  fingerprint?: string;
}

const fingerprintOf = (bytes: string | Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;

/** Build the marker for a value reached through a field whose name matched `looksSecret`.
 *  Called on the raw value, never on something already walked: a secret-named field's
 *  contents are never recursed into. */
function markSecret(value: unknown): RedactedMarker {
  if (value === null || value === undefined) return { redacted: true, present: false };
  if (typeof value === "string") {
    if (value.length === 0) return { redacted: true, present: false };
    return { redacted: true, present: true, length: value.length, fingerprint: fingerprintOf(value) };
  }
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) return { redacted: true, present: false };
    return { redacted: true, present: true, length: value.length, fingerprint: fingerprintOf(value) };
  }
  if (Array.isArray(value)) return { redacted: true, present: true, type: "array" };
  if (typeof value === "object") return { redacted: true, present: true, type: "object" };
  if (typeof value === "number") return { redacted: true, present: true, type: "number" };
  if (typeof value === "boolean") return { redacted: true, present: true, type: "boolean" };
  // Function, symbol, bigint: none can be JSON-serialised. Redacted rather than let
  // through unexamined.
  return { redacted: true, present: true };
}

/** Walk `value`, replacing the value of every secret-named field with its marker. `seen`
 *  tracks objects/arrays on the current path only (added on entry, removed on exit) so a
 *  cycle is caught without mistaking a value reachable from two different branches for one. */
function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // Array elements carry no field name of their own; only an object key can look
      // secret. An array of bare secret strings is safe because the key pointing at that
      // array is checked one level up, and markSecret redacts the whole array before this
      // branch is reached.
      return value.map((item) => walk(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      out[key] = looksSecret(key) ? markSecret(fieldValue) : walk(fieldValue, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Redact a settings response before it reaches a browser. Pure, never throws.
 *
 * DELIBERATE: a bare secret string with no surrounding field name comes back unchanged —
 * there is no key for `looksSecret` to test. Every route this protects returns a structured
 * object, so the shape forces a response to be built as named fields first.
 */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet<object>());
}
