/**
 * A person's platform access tokens.
 *
 * THE BLOCK CREDENTIAL STORE WAS THE OTHER HALF OF THIS FILE and went with the concept. It
 * held one key per person per third-party server, injected at the proxy on every call, and
 * there is no proxy and no third-party server any more — a plugin declares the servers its
 * own skills call. What is left is what was always a different subject that happened to
 * share a filename: the tokens a person uses to reach THIS platform.
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
  // NO SCOPE, AND THE LITERAL 'member' IS WHY THIS MATTERS. Self-issuing a token wrote
  // `member` regardless of who was asking, so a superadmin who minted their own token was
  // quietly handed one that could not administer anything — and the platform's advice for
  // being refused was to mint a token, which produced another of the same. A token carries
  // whatever its holder may do; migration 053 drops the column that said otherwise.
  await db.query(
    "insert into pat (principal_id, token_hash, label) values ($1,$2,$3)",
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
