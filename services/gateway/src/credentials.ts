/**
 * The credential store, and the personal keys and tokens a person keeps in it.
 *
 * ONE FILE ON DISK AND ONE WRITER. Every mutation goes through `withCredentials`, which
 * serialises writes behind a promise queue — two tools setting a key in the same second
 * would otherwise each read the file, each add their own entry, and the second write would
 * lose the first. A gate check holds this: nothing else may name the credential path.
 *
 * A key is checked before it is stored, on every path, because a credential that is wrong
 * fails at the block rather than here and the person is told their block is broken.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { CredentialStore, mask, mintPat, parseCaller, whyNot } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { PLATFORMS } from "./blocks.js";
import { platformDb } from "./db.js";
import { logEvent } from "./events.js";
import { sha256 } from "./identity.js";

const CRED_PATH = "/data/credentials.json";
/** The credential store, or a sentence saying what is wrong with it.
 *
 * Both parses threw: a SyntaxError from a truncated file, a ZodError from a shape that does
 * not fit. Either arrived as a dump — through an MCP tool answer, or as a 500 on a block
 * call — and the reader is an operator whose platform has just stopped injecting anybody's
 * key. @zz/catalog reached the same conclusion about a manifest.
 *
 * REFUSING IS RIGHT, and the message says why. This file is every person's key to somebody
 * else's platform, and returning `{}` for an unreadable one would silently drop the whole
 * platform back to no credentials at all — every block call falling through to the
 * "store a key first" guidance, for people who stored one long ago. */
export const load = (): CredentialStore => {
  if (!existsSync(CRED_PATH)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CRED_PATH, "utf8"));
  } catch (err) {
    throw new Error(`${CRED_PATH} is not readable as JSON — ${(err as Error).message}. It holds ` +
                    "every person's block key; restore it from a backup rather than deleting it.");
  }
  const checked = CredentialStore.safeParse(parsed);
  if (checked.success) return checked.data;
  const why = whyNot(checked.error);
  throw new Error(`${CRED_PATH} is not a credential store — ${why}`);
};
/** Write the store so a reader can never see a half-written file.
 *
 * writeFileSync truncates and then writes, so a crash or a concurrent read between those
 * two steps yields a truncated or empty credentials.json — every stored key gone. Writing a
 * sibling and renaming makes the swap atomic: a reader sees the old file or the new one. */
function save(data: CredentialStore): void {
  mkdirSync("/data", { recursive: true, mode: 0o700 });
  const tmp = `${CRED_PATH}.${process.pid}.tmp`;
  // 0600, and on the TEMP file — rename preserves the mode it was created with, so setting
  // it afterwards would leave a window where the new file is world-readable. This is the
  // most sensitive file the platform holds: every person's key to somebody else's real
  // platform, in plaintext by design. It was written 0644 in a volume only this container
  // mounts, which is defensible and is not a reason to leave it that way — the backup that
  // copies it out already goes to 0600, and this is the same argument one step earlier.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, CRED_PATH);
}
/** Serialise every read-modify-write of the credential store.
 *
 * load() → mutate → save() rewrites the WHOLE file, so two calls interleaving lose one of
 * them: both read the same store, both write their own copy, and the second erases the
 * first user's key with no error and no trace. Two people onboarding at once is the normal
 * case, not a rare one.
 *
 * A promise chain is enough because one process owns this file — the gateway is a single
 * container, and nothing else writes /data/credentials.json. If it is ever replicated, this
 * must become a database row or a real lock; the chain would silently stop being sufficient.
 */
let credQueue: Promise<unknown> = Promise.resolve();
export function withCredentials<T>(fn: (data: CredentialStore) => T): Promise<T> {
  const run = credQueue.then(() => {
    const data = load();
    const out = fn(data);
    save(data);
    return out;
  });
  credQueue = run.catch(() => undefined);   // one failure must not wedge the queue
  return run;
}
export const caller = (): ReturnType<typeof parseCaller> => parseCaller(requestHeaders());
/** Refuse anyone who is not an operator acting through an admin-scope credential.
 *
 * Returns the refusal, or null to proceed.
 *
 * The role comes from the identity headers, which the middleware writes from the database —
 * trustworthy for WHO. It says nothing about the TOKEN in their hand, and `role !== "admin"`
 * was the whole check.
 *
 * IT ASKS THE PERSON, NOT THE TOKEN. This also refused when the caller held a PAT stamped
 * `member`, which made the same act allowed or forbidden depending on which of their
 * credentials they happened to be holding. A token does not decide what somebody may do —
 * if the answer is no, it is no because of who they are, and it is the same no from every
 * door and every credential they own. */
export function operatorOnly(): string | null {
  if (caller().role !== "admin") return "ERROR: admin role required";
  return null;
}
/** Refuse something that cannot be a key, before it reaches the store.
 *
 * Returns the refusal, or null to proceed.
 *
 * The two person-facing setters each carried their own `key.length < 8`, and
 * credential_admin_set — the ONBOARDING BATCH path, the one that runs many at once with a
 * blank field scrolling past — had none. A blank key stores as "", and the resolver reads ""
 * as absent: the operator is told it worked and the person has no key at all, with nothing
 * anywhere saying so. When shared keys existed this was worse still — they fell through to
 * the team's and spent somebody else's quota without knowing it. A three-character typo is
 * worse than a blank either way, because it is truthy and gets injected.
 */
export function implausibleKey(key: string): string | null {
  return key.length < 8 ? "ERROR: that does not look like a valid key" : null;
}
/** Which platforms the caller has stored a personal key for — the raw values, keyed by
 *  platform. Never masked or redacted here: `credential_list` (below) masks for an agent
 *  that already holds the key; settings.ts's route redacts fully for a browser that must
 *  never see even a fragment of it. Presentation is the caller's job, not this function's. */
export function myCredentialsFor(email: string): Record<string, string> {
  return load()[email] ?? {};
}
export type SetCredentialOutcome =
  | { ok: true; platformName: string; masked: string; replacedMasked: string | null }
  | { ok: false; error: string };

/** Store the caller's own key for a platform. See the module-level comment above for
 *  `extraDetail`. */
export async function setMyCredentialFor(
  email: string, platform: string, apiKey: string, extraDetail: Record<string, unknown> = {},
): Promise<SetCredentialOutcome> {
  const conf = PLATFORMS[platform];
  if (!conf) return { ok: false, error: `unknown platform '${platform}' — see platform_list` };
  const key = apiKey.trim();
  const weak = implausibleKey(key);
  if (weak) return { ok: false, error: weak.replace(/^ERROR: /, "") };
  // Say whether this REPLACED one. Storing a key is normally an update, so a warning would
  // be noise — but the response saying the same words either way means a caller who
  // overwrote the wrong entry learns nothing at the one moment they could still act on it.
  const replaced = await withCredentials((data) => {
    const had = data[email]?.[platform];
    (data[email] ??= {})[platform] = key;
    return had ? mask(had) : null;
  });
  logEvent({
    actor: email, kind: "credential.set", subject: `${email}:${platform}`,
    detail: { ...(replaced ? { replaced: true } : {}), ...extraDetail },
  });
  return { ok: true, platformName: conf.name, masked: mask(key), replacedMasked: replaced };
}
/** Remove the caller's own key for a platform. See the module-level comment above for
 *  `extraDetail`. Returns whether anything was actually removed — only then is an event
 *  logged, the same rule the original tool body used. */
export async function deleteMyCredentialFor(
  email: string, platform: string, extraDetail: Record<string, unknown> = {},
): Promise<boolean> {
  const had = await withCredentials((data) => {
    if (!data[email]?.[platform]) return false;
    delete data[email][platform];
    // And the person, once it was their last key — otherwise deleting your only key leaves
    // your address behind in the most sensitive file the platform holds.
    if (Object.keys(data[email]).length === 0) delete data[email];
    return true;
  });
  if (had) logEvent({ actor: email, kind: "credential.delete", subject: `${email}:${platform}`, detail: extraDetail });
  return had;
}
/** The caller's own access tokens, masked at the query level (only a hash is ever stored) —
 *  when each was issued, last used, and whether revoked. */
export async function myAccessTokensFor(email: string): Promise<Array<{
  id: string; label: string; scope: string; created_at: string; last_used_at: string | null; revoked_at: string | null;
}>> {
  const r = await platformDb().query(
    `select pat.id, pat.label, pat.scope, pat.created_at, pat.last_used_at, pat.revoked_at
     from pat join principal p on p.id = pat.principal_id
     where p.email = $1 order by pat.created_at desc`, [email]);
  return r.rows;
}
export type IssueTokenOutcome =
  | { ok: true; token: string; label: string; email: string }
  | { ok: false; error: string };

/** Issue a brand new personal access token for the caller. See the module-level comment
 *  above for `extraDetail`. The token is returned in plaintext here — same as the MCP tool
 *  always has — because minting it IS handing it over; what each CALLER does with that
 *  plaintext afterwards (an agent's chat turn vs. settings.ts's one-time browser response)
 *  is the boundary that matters, and it is drawn at the call site, never in here. */
export async function issueMyAccessTokenFor(
  email: string, label: string | undefined, extraDetail: Record<string, unknown> = {},
): Promise<IssueTokenOutcome> {
  const db = platformDb();
  const r = await db.query<{ id: string; status: string }>(
    "select id, status from principal where email = $1", [email]);
  if (!r.rows[0]) {
    return { ok: false, error:
      `${email} is not a platform member yet. Ask a platform admin to add you ` +
      "(person_add, then member_add for your team) — a token can only carry access you have." };
  }
  if (r.rows[0].status !== "active") return { ok: false, error: `${email} is deactivated` };
  const token = mintPat();
  await db.query(
    "insert into pat (principal_id, token_hash, label, scope) values ($1,$2,$3,'member')",
    [r.rows[0].id, sha256(token), label ?? ""]);
  logEvent({ actor: email, kind: "pat.self_issue", subject: label ?? "", detail: extraDetail });
  return { ok: true, token, label: label ?? "", email };
}
/** Revoke one of the caller's own tokens. See the module-level comment above for
 *  `extraDetail`. Returns whether an active token of theirs actually matched — the query's
 *  own `principal_id = (select id from principal where email = $2)` is what makes "someone
 *  else's token id" and "no such token" indistinguishable, which is the whole authorisation
 *  story for this act: there is no id a caller could name that reaches past their own rows. */
export async function revokeMyAccessTokenFor(
  email: string, id: string, extraDetail: Record<string, unknown> = {},
): Promise<boolean> {
  const r = await platformDb().query(
    `update pat set revoked_at = now()
     where id = $1 and revoked_at is null
       and principal_id = (select id from principal where email = $2)
     returning id`, [id, email]);
  if (!r.rowCount) return false;
  logEvent({ actor: email, kind: "pat.self_revoke", subject: id, detail: extraDetail });
  return true;
}
