/**
 * The one write path a platform access token goes through, wherever it is issued from.
 *
 * A caller hands in its own already-open database connection — the gateway's platformDb()
 * pool and zz-core's own db() pool both connect to the same physical `zz` schema, and nothing
 * here assumes which one it is. Every statement is schema-qualified for that reason: zz-core's
 * pool carries no `search_path`, unlike the gateway's.
 *
 * COUPLED: the gateway's pat_issue and pat_revoke tools call these. One mint-and-store
 * statement, one revoke statement — a second copy of either would be a second credential
 * mechanism.
 */
import { mintPat, sha256 } from "./identity.js";

/** The minimal shape both services' pg.Pool already satisfies. Declared here rather than
 *  depending on the `pg` package, which this package otherwise has no reason to carry. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** Mint a token, hash it, and write the one row that makes it live — replacing any existing
 *  token with the same label first, because a label names one purpose and a purpose has one
 *  current credential. Returns the plaintext (shown once, never stored again) and the new
 *  row's id. */
export async function issuePat(db: Db, args: {
  principalId: string; teamId: string | null; label?: string; expiresAt: string | null;
}): Promise<{ token: string; patId: string; replaced: number }> {
  const token = mintPat();
  // DELIBERATE: an unlabelled token is exempt from the replace-by-label rule, matching
  // pat_issue's own rule — "" is not a purpose, so a caller wanting a second deliberate token
  // leaves the label off or names it differently.
  const replaced = args.label
    ? (await db.query("delete from zz.pat where principal_id = $1 and label = $2",
                       [args.principalId, args.label])).rowCount ?? 0
    : 0;
  const r = await db.query<{ id: string }>(
    `insert into zz.pat (principal_id, token_hash, label, team_id, expires_at)
     values ($1,$2,$3,$4,$5) returning id`,
    [args.principalId, sha256(token), args.label ?? "", args.teamId, args.expiresAt],
  );
  return { token, patId: r.rows[0].id, replaced };
}

/** Revoke a token by id. Returns whether a live token was actually revoked — false for a
 *  token that does not exist or was already revoked, which is what makes a second call a
 *  no-op rather than a second event. */
export async function revokePat(db: Db, patId: string): Promise<boolean> {
  const r = await db.query(
    "update zz.pat set revoked_at = now() where id = $1 and revoked_at is null", [patId]);
  return (r.rowCount ?? 0) > 0;
}
