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
  /** One connection out of the pool, held open across a transaction and handed back. */
  connect(): Promise<DbConnection>;
}

/** A connection held out of the pool for as long as a transaction lasts. Nothing outside this
 *  module names it: a caller satisfies `connect()`'s return structurally. */
interface DbConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

/** Mint a token, hash it, and write the one row that makes it live — revoking any live token
 *  with the same label first, because a label names one purpose and a purpose has one current
 *  credential. Returns the plaintext (shown once, never stored again), the new row's id, and
 *  how many rows the revoke took out. */
export async function issuePat(db: Db, args: {
  principalId: string; teamId: string | null; label?: string; expiresAt: string | null;
}): Promise<{ token: string; patId: string; replaced: number }> {
  const token = mintPat();
  const label = args.label ?? "";
  // One live token per purpose is the database's own rule — the partial unique index
  // (principal_id, label) where revoked_at is null. The revoke and the insert commit together or
  // not at all: issued as two transactions, a failure between them would end the purpose with no
  // live token and take away access nobody asked to lose. The token being replaced is revoked,
  // never deleted, so what it obtained keeps its provenance and its `last_used_at`.
  //
  // DELIBERATE: an unlabelled token is exempt (label <> ''), as the index is — "" is not a
  // purpose, so a caller wanting a second deliberate token leaves the label off or names it
  // differently.
  const client = await db.connect();
  let patId: string;
  let replaced: number;
  try {
    await client.query("begin");
    const revoked = await client.query(
      "update zz.pat set revoked_at = now() " +
      "where principal_id = $1 and label = $2 and label <> '' and revoked_at is null",
      [args.principalId, label]);
    const issued = await client.query(
      `insert into zz.pat (principal_id, token_hash, label, team_id, expires_at)
       values ($1,$2,$3,$4,$5) returning id`,
      [args.principalId, sha256(token), label, args.teamId, args.expiresAt],
    );
    await client.query("commit");
    patId = String(issued.rows[0].id);
    replaced = revoked.rowCount ?? 0;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  return { token, patId, replaced };
}

/** Revoke a token by id. Returns whether a live token was actually revoked — false for a
 *  token that does not exist or was already revoked, which is what makes a second call a
 *  no-op rather than a second event. */
export async function revokePat(db: Db, patId: string): Promise<boolean> {
  const r = await db.query(
    "update zz.pat set revoked_at = now() where id = $1 and revoked_at is null", [patId]);
  return (r.rowCount ?? 0) > 0;
}
