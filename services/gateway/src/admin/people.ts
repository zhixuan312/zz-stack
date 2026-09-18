/**
 * People on the platform, and the tools they may reach.
 *
 * Adding somebody, retiring them, the enrolment link they sign in with, and the per-tool
 * grants that widen or narrow what their team's agents can call. Same outcome shape as the
 * team writes beside them, for the same reason.
 */
import { platformDb } from "../db.js";
import { auditAdmin, type Identity } from "../identity.js";
import { issueEnrolment } from "../passkey.js";
import { principalId, superOnly } from "./authority.js";

// -------------------------------------------------------------- shared platform-write logic
//
// The guarded bodies behind person_list, person_add, person_deactivate, team_create,
// team_archive, tool_grant and tool_revoke — extracted (Task I-15) for the same reason the
// team-write functions above were (Task I-14): the admin tools and settings.ts's
// `/api/console/settings/platform/*` routes call the SAME function, guarded by the SAME
// `superOnly` check, rather than a second copy of it drifting from the first. `superOnly` is
// exported for exactly this — settings.ts imports it as a value (no cycle: this module never
// imports settings.ts) and scope-check.ts drives it directly, the same way it already drives
// `teamAuthority`.
export type PlatformWriteOutcome = { ok: true; message: string } | { ok: false; status: 400 | 403; error: string };
/** Every principal, each with the teams they are in and who added them. Read-only, but still
 *  behind `superOnly` — this is the roster a plain member never sees, on MCP or the console. */
export async function listPeople(
  id: Identity | null,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; status: 403; error: string }> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  // See the `person_list` tool's own former comment: `membership.added_by` is written on
  // every row and was selected nowhere, so "who put this person in this team" — the one
  // question an access review asks — had no answer on the platform that recorded it.
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
  await platformDb().query("update principal set status='deactivated', updated_at=now() where email=$1", [email.toLowerCase()]);
  // AND THEIR TOKENS ARE REVOKED, not merely made unusable by a status this act can undo.
  //
  // Deactivation stopped a PAT working because `resolvePat` refuses a principal that is not
  // active — true, and true only while the principal stays deactivated. `addPerson` is an
  // upsert that sets `status='active'`, so re-adding somebody who had left silently brought
  // every token they held before they left back to life, months later, with nobody choosing
  // to. Credentials do not come back because a row was touched; they come back because
  // somebody issues them.
  const revoked = await platformDb().query(
    `update pat set revoked_at = now()
       where revoked_at is null
         and principal_id = (select id from principal where email = $1)`, [email.toLowerCase()]);
  auditAdmin(id, "deactivate_person", email, { ...extraDetail, patsRevoked: revoked.rowCount ?? 0 });
  // WHAT THIS DOES NOT DO, said where the act happens. Deactivation stops them
  // authenticating; it does not touch the building-block keys stored under their address,
  // which are live credentials at somebody else's service belonging to a person who has
  // left. zz-access's skill states the rule — "deactivating them stops them authenticating
  // and does NOT touch the key... Remove the key too" — but that is a different agent on a
  // different door, so the operator performing this act never read it. The tool that
  // removes one is on /manage, which is why this names the agent rather than the tool.
  return { ok: true, message:
    `principal ${email} deactivated, and ${revoked.rowCount ?? 0} live token(s) revoked — ` +
    "adding them back later will not bring any of them back.\n" +
    "NOT removed: any building-block keys stored under that address. They cannot be used " +
    "by anyone now (the person can no longer authenticate), but they are live credentials " +
    "at a third party for somebody who has left. Ask the ZZ Access agent to run " +
    `credential_admin_delete for ${email} on each block they had a key for.` };
}
/** Mint an enrolment link so somebody can register a passkey.
 *
 * THE ONLY WAY A PASSKEY EVER REACHES A PRINCIPAL. passkey.ts explains why in full: an
 * authenticator asserts possession of a key, never an identity, so a registration allowed to
 * name its own account would be open self-registration. The link names the principal instead,
 * and the principal was created here, by a superadmin, before the link existed.
 *
 * Superadmin-only, like every other write in this tier — and unlike `person_add` it hands
 * back a live credential, so the refusal matters more than usual. It is the same `superOnly`
 * every function beside it calls rather than a comparison written out again here.
 *
 * THE URL IS RETURNED, ONCE. Only the token's hash is stored, so re-reading it is not
 * possible; a lost link is re-minted rather than recovered. Say so where it is handed over.
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
