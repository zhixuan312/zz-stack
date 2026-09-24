/**
 * Teams and who is in them.
 *
 * Every function here returns an outcome rather than throwing: a refusal carries the status
 * and the sentence, so the MCP tool and the console route that both call it answer the same
 * way. A write that throws would make those two disagree about what a refusal looks like.
 */
import { platformDb } from "../db.js";
import { PLATFORM_TEAM, auditAdmin, type Identity } from "../identity.js";
import { principalId, superOnly, teamAuthority, teamId } from "./authority.js";
import { type PlatformWriteOutcome } from "./people.js";

// ---------------------------------------------------------------- shared team-write logic
//
// COUPLED: the guarded bodies behind member_add and member_remove. The admin tools below and
// settings.ts's browser routes call the same function rather than a second copy of the
// authority check and the query. settings.ts imports these as values; this module never
// imports settings.ts, so there is no cycle here for dependency injection to avoid.
//
// Each write takes `extraDetail`, merged into its own `auditAdmin` call's detail — a tool call
// passes none, settings.ts's routes pass `{ via: "web" }`. The marker is added by the caller;
// the gate's "every console write route records the door it came through" reads that literal
// text back out of the route body.
//
// Not exported: settings.ts imports the four functions below as values and lets their return
// type infer, so nothing outside this file needs to name this shape.
type TeamWriteOutcome = { ok: true; message: string } | { ok: false; status: 400 | 403; error: string };
/** Add a principal to a team, or change their role — the same call, because the insert's
 * own `on conflict (team_id, principal_id) do update set role = excluded.role` already
 * handles both. A second code path for "already a member" would only be a second way for
 * add and change-role to disagree about what happened. */
export async function addMember(
  id: Identity | null, team: string, email: string, role: "member" | "admin" | undefined,
  extraDetail: Record<string, unknown> = {},
): Promise<TeamWriteOutcome> {
  if (!teamAuthority(id, team)) return { ok: false, status: 403, error: `team admin or superadmin required for ${team}` };
  const db = platformDb();
  const tid = await teamId(db, team);
  const pid = await principalId(db, email);
  if (!tid) {
    return { ok: false, status: 400,
      error: `no active team '${team}' — team_create on the same slug restores an archived one` };
  }
  if (!pid) return { ok: false, status: 400, error: `no principal '${email}' — person_add first` };
  const actorId = await principalId(db, id.email);
  await db.query(
    `insert into membership (team_id, principal_id, role, added_by) values ($1,$2,$3,$4)
     on conflict (team_id, principal_id) do update set role = excluded.role`,
    [tid, pid, role ?? "member", actorId],
  );
  auditAdmin(id, "add_member", `${team}:${email}`, { role: role ?? "member", ...extraDetail }, team);
  return { ok: true, message: `${email} is now ${role ?? "member"} of ${team}` };
}
/** Remove a principal from a team. `confirm` must repeat the team slug exactly. */
export async function removeMember(
  id: Identity | null, team: string, email: string, confirm: string,
  extraDetail: Record<string, unknown> = {},
): Promise<TeamWriteOutcome> {
  if (!teamAuthority(id, team)) return { ok: false, status: 403, error: `team admin or superadmin required for ${team}` };
  if (confirm !== team) return { ok: false, status: 400, error: `confirm must repeat the team slug exactly ('${team}')` };
  const db = platformDb();
  // What was actually deleted, not what was asked for: reporting "removed" whatever happened
  // makes a mistyped address read as done while the person it was meant for stays a member.
  // COUPLED: the destructive siblings hold the same rule — team_archive refuses an inactive
  // team, pat_revoke refuses an id that is not there.
  const r = await db.query(
    `delete from membership using team t, principal p
     where membership.team_id = t.id and membership.principal_id = p.id
       and t.slug = $1 and p.email = $2`,
    [team, email.toLowerCase()],
  );
  if (!r.rowCount) {
    return { ok: false, status: 400, error:
      `${email} is not a member of ${team} — nothing was removed. Check the address and the team with team_list.` };
  }
  auditAdmin(id, "remove_member", `${team}:${email}`, { ...extraDetail }, team);
  return { ok: true, message: `${email} removed from ${team}. ` +
    "Any access token bound to this team stops working now — it names a team they are no " +
    "longer in, and identity refuses it outright." };
}
/** Create a team (slug is the stable identity used everywhere). */
export async function createTeam(
  id: Identity | null, slug: string, name: string,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  const db = platformDb();
  const pid = await principalId(db, id.email);
  // The platform's own team is not a tenant's to take: its store holds what we have
  // learned about the registry entries every tenant depends on, and a team owning that
  // slug would both read and write it.
  if (slug === PLATFORM_TEAM) {
    return { ok: false, status: 400,
      error: `'${PLATFORM_TEAM}' is the platform's own team and cannot be created or claimed.` };
  }
  // `do nothing` would report "team X active" for a slug that already existed — a lie when it
  // was archived, which is the case where someone types team_create precisely because they want
  // it back. Reactivate, and say which happened.
  const r = await db.query<{ status: string; existed: boolean }>(
    `insert into team (slug, name, created_by) values ($1,$2,$3)
     on conflict (slug) do update set status = 'active', name = excluded.name
     returning status, (xmax <> 0) as existed`,
    [slug, name, pid],
  );
  const existed = r.rows[0]?.existed ?? false;
  auditAdmin(id, "create_team", slug, { reactivated: existed, ...extraDetail }, slug);
  return { ok: true, message: existed
    ? `team ${slug} already existed and is now active`
    : `team ${slug} active` };
}
/** Retire a team. `confirm` must repeat the team slug exactly. */
export async function archiveTeam(
  id: Identity | null, team: string, confirm: string,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required (retiring a team removes access)" };
  if (confirm !== team) return { ok: false, status: 400, error: `confirm must repeat the team slug exactly ('${team}')` };
  const db = platformDb();
  const r = await db.query("update team set status = 'archived' where slug = $1 and status = 'active'", [team]);
  if (!r.rowCount) return { ok: false, status: 400, error: `no active team '${team}'` };
  auditAdmin(id, "archive_team", team, { ...extraDetail }, team);
  return { ok: true, message: `team ${team} archived.\n` +
    "Its memberships and its store are kept, so team_create on the same slug restores it." };
}
