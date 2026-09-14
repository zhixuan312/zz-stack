/**
 * The response redactor (← Task I-12, AC-4).
 *
 * WHY THIS EXISTS: the credential store is a plaintext JSON file at /data/credentials.json
 * (see server.ts, CRED_PATH). Its credential and token tools — credential_list,
 * credential_set, pat_list, pat_issue, client_setup, and their admin siblings —
 * were written for a caller that was always an AGENT holding a PAT, never a web page. Tasks
 * I-13 to I-15 put those same capabilities behind browser routes, and the risk changes
 * completely when the caller is a page that can be left open on a shared screen,
 * screenshotted, or read by anything with the session cookie. A value that was acceptable to
 * hand an agent is not acceptable to hand a browser, and this module is where that line is
 * drawn ONCE rather than remembered at nine call sites.
 *
 * `redact(value)` walks an arbitrary structure — objects, arrays, any nesting of either,
 * primitives — and replaces the VALUE of every field whose NAME looks like a secret with a
 * presence marker. Everything else survives unchanged.
 *
 * THE FIELD RULE, and why it is a substring match on the NAME rather than a list of exact
 * field names: `token`, `secret`, `password`, `key`, `credential`, `authorization`,
 * `verifier`. A future field is safe by DEFAULT the moment its name contains one of these —
 * `client_secret`, `password_verifier`, `api_key`, `token_hash`, `Authorization` (a header),
 * `refresh_token` are all caught without anyone having enumerated them here. The cost of a
 * substring match is a false positive on a field that merely mentions one of these words
 * without holding a secret (there are none among the shapes this module was built for), and
 * that cost is the point: fail CLOSED. A field the rule does not recognise passes through
 * untouched, so the ENTIRE safety of this module rests on the list above naming every word a
 * secret-bearing field is spelled with — which is exactly why `SECRET_NAME_PARTS` and
 * `looksSecret` are exported and driven directly by redact-check.ts, rather than restated
 * there as a second copy of the rule that could drift from this one.
 *
 * THE PRESENCE MARKER never carries a prefix, a suffix, or any substring of the original
 * value — `mask()` in packages/contracts/src/index.ts (`key.slice(0, 4)…key.slice(-4)`) is
 * exactly that shape, and it is the right shape for an agent that already holds a PAT and is
 * reading its OWN key back, never for a page. Four characters of a scrypt-strength API key is
 * not zero information, and "never enough to use it" is a much lower bar than "cannot be
 * combined with anything else to get closer to the value" — a browser tab is read by
 * screenshot, not by someone trying to brute-force the rest from four known characters, but
 * this module does not get to assume that about every future reader of what it returns. What
 * a page's viewer actually needs is answered by pat_list's own precedent: enough to CONFIRM
 * a value is set and tell it apart from another (an id, a label, a scope, a team, when it was
 * set, by whom) — never a piece of the value itself, because pat_list never had one to leak
 * in the first place; the plaintext token was never in the row it queries. This module holds
 * to the same bar for a value it DOES have in hand: a presence flag, a length, and a SHA-256
 * fingerprint truncated to 12 hex characters. A fingerprint is one-way — it identifies "is
 * this the same secret as before" (useful for confirming a rotation actually rotated
 * something) without being a step towards reconstructing it, which four real characters
 * always are.
 *
 * THE ONE EXCEPTION: a single newly-issued access token, from the browser
 * counterpart (I-13). It is shown exactly once and is useless to the platform forever after,
 * so redacting it would not protect anything — it would just break the one response whose
 * entire purpose is handing over a secret the caller asked for. That route MUST return the
 * token directly, built as its own small JSON payload, and MUST NOT pass that payload through
 * redact() — the exemption lives entirely in that route choosing not to call this function on
 * that one response, not in a flag or branch anywhere in this file. redact() itself makes no
 * exception for a field named `token`: if a token payload were ever passed through here by
 * mistake, it WOULD be redacted (redact-check.ts drives exactly this case), which is what
 * makes "don't call redact() here" the only place the exception can live — there is no
 * override to reach for instead.
 *
 * CYCLES: a value already on the current path (an ancestor of itself through some chain of
 * object/array references) is replaced with the string "[Circular]" rather than walked again
 * — the `seen` set below is scoped to the current branch (added on entry, removed on exit), so
 * a value referenced twice from two DIFFERENT branches (not a cycle) is still redacted
 * correctly both times.
 *
 * Pure. Never throws — on null, undefined, a Date, a Buffer, a cycle, or a shape this file has
 * never seen. An unrecognised shape is redacted the same way a recognised one is: by walking
 * it and applying the one field-name rule, never by returning `{}` or refusing — a redactor
 * that could not describe a shape it didn't expect would be exactly as dangerous as one that
 * forgot a field name, and harder to notice.
 */
import { createHash } from "node:crypto";

/** Substrings whose presence in a field name (case-insensitively) marks that field's value a
 *  secret. See the module doc comment for why this is a substring match rather than an exact
 *  field-name list, and why fail-closed is the point rather than a side effect. */
export const SECRET_NAME_PARTS = [
  "token",
  "secret",
  "password",
  "key",
  "credential",
  "authorization",
  "verifier",
] as const;

/** The field rule itself, exported so redact-check.ts drives the REAL predicate rather than
 *  a restatement of it. */
export function looksSecret(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return SECRET_NAME_PARTS.some((part) => lower.includes(part));
}

/** What a secret-named field's value becomes. Never a prefix or fingerprint-free echo of the
 *  value — see the module doc comment for why `present` + `length` + `fingerprint` is the
 *  whole of what survives. */
export interface RedactedMarker {
  redacted: true;
  /** Whether the original value was present and non-empty. `false` for null, undefined, an
   *  empty string, or an empty buffer — "no key stored" is metadata worth keeping, not a
   *  secret itself. */
  present: boolean;
  /** The type of the redacted value, when it was neither a string nor absent — an object or
   *  array reached through a secret-named field is not peeked into; the field's NAME already
   *  said everything beneath it is secret-shaped. */
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
 *  Called on the RAW value — never on something already walked — because a secret-named
 *  field's contents are never recursed into; see the module doc comment. */
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
  // Function, symbol, bigint: none of these shapes appear in any settings response this
  // module was built for, and none of them can be JSON-serialised anyway. Redact
  // conservatively rather than let one through unexamined.
  return { redacted: true, present: true };
}

/** Walk `value`, replacing the value of every secret-named field with its marker. `seen`
 *  tracks objects/arrays on the CURRENT path only (added on entry, removed on exit) so a
 *  cycle is caught without mistaking a value reachable from two different branches for one. */
function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // Array elements carry no field name of their own — only an object KEY can look
      // secret. An array of bare secret strings is only ever safe here because the KEY that
      // points at that array (e.g. "credentials") is itself checked by looksSecret one level
      // up, which redacts the whole array at once via markSecret rather than reaching this
      // branch at all.
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
 * A bare secret string passed with no surrounding field name (`redact("ghp_abcd…")`) comes
 * back unchanged — there is no key for `looksSecret` to test, so there is nothing this
 * function can decide. That is a deliberate limitation, not a gap: every route this module
 * protects returns a structured object or array of them, never a naked string, and the
 * design requirement this shape enforces is exactly "build the response as named fields
 * before it reaches this function" — the same discipline pat_list already follows.
 */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet<object>());
}
