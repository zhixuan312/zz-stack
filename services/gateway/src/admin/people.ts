/**
 * People on the platform.
 *
 * Adding somebody, retiring them, and the enrolment link they sign in with. Same outcome shape
 * as the team writes beside them, for the same reason.
 */
import { platformDb } from "../db.js";
import { auditAdmin, type Identity } from "../identity.js";
import { issueEnrolment } from "../passkey.js";
import { principalId, superOnly } from "./authority.js";

// The guarded bodies behind person_list, person_add, person_deactivate, team_create and
// team_archive.
//
// COUPLED: the admin tools and settings.ts's `/api/console/settings/platform/*` routes call
// these same functions behind the same `superOnly` check. `superOnly` is exported for that —
// settings.ts imports it as a value (no cycle: this module never imports settings.ts) and
// scope-check.ts drives it directly, the way it drives `teamAuthority`.
export type PlatformWriteOutcome = { ok: true; message: string } | { ok: false; status: 400 | 403; error: string };
/** Every principal, each with the teams they are in and who added them. Read-only, but still
 *  behind `superOnly` — this is the roster a plain member never sees, on MCP or the console. */
export async function listPeople(
  id: Identity | null,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; status: 403; error: string }> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  // `membership.added_by` is selected here because it answers the question an access review
  // asks: who put this person in this team.
  const r = await platformDb().query(
    `select p.email, p.display_name, p.role, p.status, p.created_at,
            coalesce(json_agg(json_build_object(
              'team', t.slug, 'role', m.role, 'added_by', a.email, 'added_at', m.created_at)
              order by t.slug) filter (where t.slug is not null), '[]') as teams
       from principal p
       left join membership m on m.principal_id = p.id
       left join team t on t.id = m.team_id
       left join principal a on a.id = m.added_by
      group by p.id order by p.email`);
  return { ok: true, rows: r.rows };
}
/** Create a principal (platform member). A browser account is made separately, by an
 *  operator; this links to it by email. */
export async function addPerson(
  id: Identity | null, email: string, displayName: string | undefined,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  await platformDb().query(
    `insert into principal (email, display_name) values ($1, $2)
     on conflict (email) do update set display_name = coalesce(nullif(excluded.display_name,''), principal.display_name), status='active'`,
    [email.toLowerCase(), displayName ?? ""],
  );
  auditAdmin(id, "add_person", email, { ...extraDetail });
  return { ok: true, message: `principal ${email} active` };
}
/** Deactivate a principal. `confirm` must repeat the email exactly. */
export async function deactivatePerson(
  id: Identity | null, email: string, confirm: string,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  if (confirm !== email) return { ok: false, status: 400, error: `confirm must repeat the email exactly ('${email}')` };
  // And everything they could still get in with is ended, not merely made unusable by a status
  // this act can undo: `addPerson` is an upsert that sets `status='active'`, so re-adding
  // somebody who had left would otherwise bring back every token, console session and unused
  // enrolment link they held. Tokens and sessions are revoked, unused links are spent, and all
  // of it commits with the status change or none of it does.
  const client = await platformDb().connect();
  let revoked: { pats: number; sessions: number; links: number };
  try {
    await client.query("begin");
    const who = await client.query<{ id: string }>(
      "update principal set status='deactivated', updated_at=now() where email=$1 returning id",
      [email.toLowerCase()]);
    const principal = who.rows[0]?.id ?? null;
    const pats = await client.query(
      "update pat set revoked_at = now() where revoked_at is null and principal_id = $1", [principal]);
    const sessions = await client.query(
      "update console_session set revoked_at = now() where revoked_at is null and principal_id = $1", [principal]);
    const links = await client.query(
      "update passkey_enrolment set used_at = now() where used_at is null and principal_id = $1", [principal]);
    await client.query("commit");
    revoked = { pats: pats.rowCount ?? 0, sessions: sessions.rowCount ?? 0, links: links.rowCount ?? 0 };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  auditAdmin(id, "deactivate_person", email, {
    ...extraDetail, patsRevoked: revoked.pats, sessionsRevoked: revoked.sessions, enrolmentsSpent: revoked.links });
  return { ok: true, message:
    `principal ${email} deactivated: ${revoked.pats} live token(s) and ${revoked.sessions} console ` +
    `session(s) revoked, ${revoked.links} unused enrolment link(s) spent — adding them back later ` +
    "will not bring any of them back." };
}
/** Mint an enrolment link so somebody can register a passkey.
 *
 * The only way a passkey reaches a principal. An authenticator asserts possession of a key,
 * never an identity, so a registration allowed to name its own account would be open
 * self-registration; the link names the principal instead, and the principal was created here
 * by a superadmin before the link existed. See passkey.ts.
 *
 * Superadmin-only through the same `superOnly` every function beside it calls.
 *
 * The URL is returned once: only the token's hash is stored, so a lost link is re-minted
 * rather than recovered.
 */
export async function issueEnrolmentLink(
  id: Identity | null, email: string, extraDetail: Record<string, unknown> = {},
): Promise<{ ok: true; url: string; expiresAt: Date; message: string } | { ok: false; status: 400 | 403; error: string }> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  const db = platformDb();
  const r = await db.query<{ id: string; status: string }>(
    "select id, status from principal where email = $1", [email.toLowerCase()]);
  if (!r.rows.length) {
    return { ok: false, status: 400, error:
      `no principal for ${email} — person_add first. A passkey attaches to an account that ` +
      "already exists; it cannot create one." };
  }
  if (r.rows[0].status !== "active") {
    return { ok: false, status: 400, error: `principal ${email} is ${r.rows[0].status}` };
  }
  const issuedBy = await principalId(db, id.email);
  const link = await issueEnrolment(r.rows[0].id, issuedBy);
  auditAdmin(id, "issue_enrolment", email, { ...extraDetail });
  return { ok: true, url: link.url, expiresAt: link.expiresAt, message:
    `Enrolment link for ${email}, good until ${link.expiresAt.toISOString()} and usable once. ` +
    "Send it to them and have them open it on the device whose passkey they want to use. " +
    "Shown once — only its hash is kept." };
}
