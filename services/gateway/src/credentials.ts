/**
 * A person's platform access tokens.
 *
 * The tokens a person uses to reach this platform, and nothing else.
 */
import { mintPat, parseCaller } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { platformDb } from "./db.js";
import { logEvent } from "./events.js";
import { sha256 } from "./identity.js";

/** Who is calling, from the request's own headers. */
export const caller = (): ReturnType<typeof parseCaller> => parseCaller(requestHeaders());

/** The caller's own access tokens, masked at the query level (only a hash is ever stored) —
 *  when each was issued, last used, and whether revoked. */
export async function myAccessTokensFor(email: string): Promise<Array<{
  id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null;
}>> {
  const r = await platformDb().query(
    `select pat.id, pat.label, pat.created_at, pat.last_used_at, pat.revoked_at
     from pat join principal p on p.id = pat.principal_id
     where p.email = $1 order by pat.created_at desc`, [email]);
  return r.rows;
}
export type IssueTokenOutcome =
  | { ok: true; token: string; label: string; email: string }
  | { ok: false; error: string };

/** Issue a new personal access token for the caller. The token is returned in plaintext,
 *  because minting it is handing it over; what a caller does with that plaintext — an agent's
 *  chat turn, settings.ts's one-time browser response — is drawn at the call site. */
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
  // No scope column: a token carries whatever its holder may do, read from the principal.
  await db.query(
    "insert into pat (principal_id, token_hash, label) values ($1,$2,$3)",
    [r.rows[0].id, sha256(token), label ?? ""]);
  logEvent({ actor: email, kind: "pat.self_issue", subject: label ?? "", detail: extraDetail });
  return { ok: true, token, label: label ?? "", email };
}
/** Revoke one of the caller's own tokens, returning whether an active token of theirs
 *  matched. The query's `principal_id = (select id from principal where email = $2)` is the
 *  whole authorisation story: "someone else's token id" and "no such token" are
 *  indistinguishable, and no id a caller names reaches past their own rows. */
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
