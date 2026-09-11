/**
 * People on the platform, and the tools they may reach.
 *
 * Adding somebody, retiring them, the enrolment link they sign in with, and the per-tool
 * grants that widen or narrow what their team's agents can call. Same outcome shape as the
 * team writes beside them, for the same reason.
 */
import { PLATFORMS, blockIds } from "../blocks.js";
import { platformDb } from "../db.js";
import { auditAdmin, type Identity } from "../identity.js";
import { issueEnrolment } from "../passkey.js";
import { principalId, superOnly, teamId } from "./authority.js";

// -------------------------------------------------------------- shared platform-write logic
//
// The guarded bodies behind list_people, add_person, deactivate_person, create_team,
// archive_team, grant_tool and revoke_tool — extracted (Task I-15) for the same reason the
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
  // See the `list_people` tool's own former comment: `membership.added_by` is written on
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
  auditAdmin(id, "deactivate_person", email, { ...extraDetail });
  // WHAT THIS DOES NOT DO, said where the act happens. Deactivation stops them
  // authenticating; it does not touch the building-block keys stored under their address,
  // which are live credentials at somebody else's service belonging to a person who has
  // left. zz-access's skill states the rule — "deactivating them stops them authenticating
  // and does NOT touch the key... Remove the key too" — but that is a different agent on a
  // different door, so the operator performing this act never read it. The tool that
  // removes one is on /manage, which is why this names the agent rather than the tool.
  return { ok: true, message:
    `principal ${email} deactivated — their PATs stop working immediately.\n` +
    "NOT removed: any building-block keys stored under that address. They cannot be used " +
    "by anyone now (the person can no longer authenticate), but they are live credentials " +
    "at a third party for somebody who has left. Ask the ZZ Access agent to run " +
    `admin_delete_credential for ${email} on each block they had a key for.` };
}
/** Mint an enrolment link so somebody can register a passkey.
 *
 * THE ONLY WAY A PASSKEY EVER REACHES A PRINCIPAL. passkey.ts explains why in full: an
 * authenticator asserts possession of a key, never an identity, so a registration allowed to
 * name its own account would be open self-registration. The link names the principal instead,
 * and the principal was created here, by a superadmin, before the link existed.
 *
 * Superadmin-only, like every other write in this tier — and unlike `add_person` it hands
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
      `no principal for ${email} — add_person first. A passkey attaches to an account that ` +
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
/** Grant a team access to a building block. Block access is a platform decision — never
 *  reachable from `teamAuthority`, only `superOnly` (AC-5). */
export async function grantTool(
  id: Identity | null, team: string, block: string,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required (block access is a platform decision)" };
  // A grant for a block that does not exist is not a harmless no-op — it is the switch
  // that turns enforcement on. The proxy's rule is "a team with ANY grant gets only its
  // granted blocks", so a team whose first and only grant is a typo loses every real
  // block at once, and the 403 it gets back names the block it asked for rather than the
  // grant that is wrong. Nothing else in the platform validates this string.
  if (!PLATFORMS[block]) {
    return { ok: false, status: 400, error:
      `no block '${block}' — this gateway routes [${blockIds().join(", ")}]. ` +
      "Granting an unknown block would switch on enforcement for this team and deny the real ones." };
  }
  const db = platformDb();
  const tid = await teamId(db, team);
  if (!tid) {
    return { ok: false, status: 400,
      error: `no active team '${team}' — create_team on the same slug restores an archived one` };
  }
  const actorId = await principalId(db, id.email);
  await db.query(
    `insert into tool_grant (team_id, block, granted_by) values ($1,$2,$3)
     on conflict do nothing`,
    [tid, block, actorId],
  );
  auditAdmin(id, "grant_tool", `${team}:${block}`, { ...extraDetail }, team);
  return { ok: true, message: `${team} may use block '${block}'` };
}
/** Revoke a team's block access. `confirm` must repeat the block id exactly. Block access is
 *  a platform decision — never reachable from `teamAuthority`, only `superOnly` (AC-5). */
export async function revokeTool(
  id: Identity | null, team: string, block: string, confirm: string,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  if (confirm !== block) return { ok: false, status: 400, error: `confirm must repeat the block id exactly ('${block}')` };
  // Same reason as uninstall_flow above, and it bites harder here: revoking a block the
  // team never had reported success, so an operator taking away the WRONG block id walked
  // away believing access was gone while the real grant stood.
  const gone = await platformDb().query(
    `delete from tool_grant using team t
     where tool_grant.team_id = t.id and t.slug = $1 and tool_grant.block = $2`,
    [team, block],
  );
  if (!gone.rowCount) {
    return { ok: false, status: 400, error:
      `${team} has no grant for '${block}' — nothing was revoked. ` +
      "list_installs shows their grants; revoking a block they never had would " +
      "have left the one you meant in place." };
  }
  auditAdmin(id, "revoke_tool", `${team}:${block}`, { ...extraDetail }, team);
  return { ok: true, message: `${team} may no longer use '${block}' (takes effect immediately)` };
}
