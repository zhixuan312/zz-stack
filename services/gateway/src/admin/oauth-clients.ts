/**
 * The OAuth clients that reach this platform's doors.
 *
 * An application registers itself at /oauth/register and holds the token it obtains, so a
 * registration is durable provenance rather than a session: being unused never removes one, and
 * ending its access is a recorded fact. These two read what is registered and revoke it.
 *
 * Same outcome shape as the team and people writes beside them, for the same reason: the MCP
 * tool and any console route that calls one answer the same way.
 */
import { platformDb } from "../db.js";
import { auditAdmin, type Identity } from "../identity.js";
import { superOnly } from "./authority.js";
import { type PlatformWriteOutcome } from "./people.js";

/** Every client this platform has registered, newest first, revoked ones included.
 *
 *  A revoked row is kept and shown: it is the provenance of the tokens that client obtained,
 *  and "who registered this, and when did we cut it off" is a question an access review asks. */
export async function listOauthClients(
  id: Identity | null,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; status: 403; error: string }> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  const r = await platformDb().query(
    `select client_id, name, redirect_uris, created_at, revoked_at
       from zz.mcp_oauth_client order by created_at desc`);
  auditAdmin(id, "list_oauth_clients", "mcp_oauth_client", { count: r.rows.length });
  return { ok: true, rows: r.rows };
}
/** Revoke a client and every live token it obtained, in one transaction.
 *
 *  Two acts, one outcome: `zz.pat.oauth_client_id` is what makes them one. A code the client is
 *  holding is refused at the exchange too, because the consume statement joins the client and
 *  reads `revoked_at is null` there — revoking the row ends what it already has, not only what
 *  it would register next. The client row is never deleted: its tokens name it.
 *
 *  A client already revoked is reported as such rather than as a fresh revocation. */
export async function revokeOauthClient(
  id: Identity | null, clientId: string, extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  const db = platformDb();
  const client = await db.connect();
  let pats = 0;
  let revokedAt: Date | null = null;
  try {
    await client.query("begin");
    const revoked = await client.query<{ revoked_at: Date }>(
      `update zz.mcp_oauth_client set revoked_at = now()
        where client_id = $1 and revoked_at is null returning revoked_at`, [clientId]);
    if (revoked.rowCount !== 1) {
      // Distinguish the two reasons there is nothing to revoke, and commit nothing either way.
      const known = await client.query<{ revoked_at: Date | null }>(
        "select revoked_at from zz.mcp_oauth_client where client_id = $1", [clientId]);
      await client.query("rollback");
      if (!known.rows.length) {
        return { ok: false, status: 400, error:
          `no client '${clientId}' — client_list names every one this platform has registered` };
      }
      return { ok: true, message:
        `client ${clientId} was already revoked at ${known.rows[0].revoked_at?.toISOString()} — nothing changed` };
    }
    revokedAt = revoked.rows[0].revoked_at;
    const tokens = await client.query(
      "update zz.pat set revoked_at = now() where oauth_client_id = $1 and revoked_at is null", [clientId]);
    await client.query("commit");
    pats = tokens.rowCount ?? 0;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  auditAdmin(id, "revoke_oauth_client", clientId, { ...extraDetail, patsRevoked: pats });
  return { ok: true, message:
    `client ${clientId} revoked at ${revokedAt?.toISOString()}: ${pats} live token(s) it obtained ` +
    "were revoked with it, and any code it is still holding is refused at the exchange. The row " +
    "stays, because the tokens it obtained name it — reconnecting needs a fresh registration." };
}
