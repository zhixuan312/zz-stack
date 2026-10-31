/**
 * Teams and who is in them.
 *
 * Every function here returns an outcome rather than throwing: a refusal carries the status
 * and the sentence, so the MCP tool and the console route that both call it answer the same
 * way. A write that throws would make those two disagree about what a refusal looks like.
 */
import type { PoolClient } from "pg";

import { inTransaction, platformDb } from "../db.js";
import { PLATFORM_TEAM, TEAM_SLUG, TEAM_SLUG_RULE, auditAdmin, type Identity } from "../identity.js";
import { isDeactivated, principalId, superOnly, teamAuthority, teamId } from "./authority.js";
import { type PlatformWriteOutcome } from "./people.js";

/** The longest team name: a display label, not a description. */
const TEAM_NAME_MAX = 120;

// ---------------------------------------------------------------- shared team-write logic
//
// COUPLED: the guarded bodies behind member_add and member_remove. The admin tools below and
// settings/team.ts's browser routes call the same function rather than a second copy of the
// authority check and the query. settings/team.ts imports these as values; this module never
// imports it, so there is no cycle here for dependency injection to avoid.
//
// Each write takes `extraDetail`, merged into its own `auditAdmin` call's detail — a tool call
// passes none, the routes in settings/team.ts and settings/platform.ts pass `{ via: "web" }`. The
// marker is added by the caller; the gate's "every console write route records the door it came
// through" reads that literal text back out of the route body.
//
// Not exported: settings/team.ts and admin.ts import the two member writes below as values and let
// their return type infer, so nothing outside this file needs to name this shape.
type TeamWriteOutcome = { ok: true; message: string } | { ok: false; status: 400 | 403; error: string };
/** Add a principal to a team, or change their role — the same statement, which keeps the role
 * a member already holds unless `role` names another, and says which of the three happened: a
 * new member, a role changed, or nothing. An omitted role is not a demotion: re-adding an admin
 * to be sure they are in must not quietly take away the authority to add the next one. A
 * deactivated principal is refused: a membership is access, and deactivation is the act that
 * ended theirs. */
export async function addMember(
  id: Identity | null, team: string, email: string, role: "member" | "admin" | undefined,
  extraDetail: Record<string, unknown> = {},
): Promise<TeamWriteOutcome> {
  // Authority first, and one refusal whether or not the team exists: answering a missing team
  // differently would tell anybody which slugs are taken. Naming the teams the caller does
  // administer is what makes a mistyped slug obvious without that.
  const mine = (id?.teams ?? []).filter((t) => t.role === "admin").map((t) => t.slug);
  if (!teamAuthority(id, team)) {
    return { ok: false, status: 403, error: `team admin or superadmin required for ${team}` +
      (mine.length ? ` — you administer ${mine.join(", ")}` : "") };
  }
  const db = platformDb();
  const tid = await teamId(db, team);
  if (!tid) {
    return { ok: false, status: 400,
      error: `no active team '${team}' — team_create on the same slug restores an archived one` };
  }
  const pid = await principalId(db, email);
  if (!pid) return { ok: false, status: 400, error: `no principal '${email}' — person_add first` };
  if (await isDeactivated(db, pid)) {
    return { ok: false, status: 400, error: `principal ${email} is deactivated — person_add restores them before a team can take them` };
  }
  const actorId = await principalId(db, id.email);
  // The role before, read in the same statement as the write, so the answer says what changed.
  const put = async (q: Pick<PoolClient, "query">) => (await q.query<{ before: string | null; role: string; email: string }>(
    `with prior as (select role from membership where team_id = $1 and principal_id = $2),
          put as (insert into membership (team_id, principal_id, role, added_by) values ($1, $2, coalesce($3, 'member'), $4)
                  on conflict (team_id, principal_id) do update set role = coalesce($3, membership.role)
                  returning role)
     select (select role from prior) as before, (select role from put) as role,
            (select email from principal where id = $2) as email`,
    [tid, pid, role ?? null, actorId])).rows[0];
  // Only role member can take away an admin; a promotion, or an add that keeps the role, writes without the lock.
  const kept = role === "member" ? await keepingLastAdmin(id, team, email, put) : { done: await put(db) };
  if ("refused" in kept) return kept.refused;
  const done = kept.done;
  if (done.before === done.role) {
    return { ok: true, message: `${done.email} is already ${done.role} of ${team} — nothing changed` };
  }
  auditAdmin(id, "add_member", `${team}:${done.email}`, { role: done.role, ...extraDetail }, team);
  return { ok: true, message: done.before
    ? `${done.email} is now ${done.role} of ${team} (was ${done.before})`
    : `${done.email} is now ${done.role} of ${team}` };
}
/**
 * `write`, which may take away `email`'s admin role in `team` (a removal or a demotion), unless they are its last active
 * admin. A team keeps someone who can add the next member: without one it is a team only a superadmin can manage, so
 * only a superadmin may leave it so. A deactivated admin keeps their row for a restore but can add nobody, so they do
 * not count.
 *
 * The count and the write share one transaction holding the team's row: read and written apart, two admins removing
 * or demoting each other at once each counted the other and left the team with none. The hold is `no key update`, so a
 * foreign key read of the team (a member added, an event written) passes it: a `for update` hold queued those, and two
 * adds of one person, one with role member, each waited for the other.
 */
async function keepingLastAdmin<T>(id: Identity | null, team: string, email: string,
                                   write: (q: PoolClient) => Promise<T>): Promise<{ refused: TeamWriteOutcome } | { done: T }> {
  return inTransaction(async (client) => {
    await client.query("select 1 from team where slug = $1 for no key update", [team]);
    if (!superOnly(id)) {
      const { rows: [last] } = await client.query<{ last: boolean }>(
        `select count(*) filter (where m.role = 'admin' and p.status = 'active') = 1
                and bool_or(m.role = 'admin' and p.status = 'active' and p.email = $2) as last
           from membership m join team t on t.id = m.team_id join principal p on p.id = m.principal_id
          where t.slug = $1`, [team, email.toLowerCase()]);
      if (last?.last) {
        return { refused: { ok: false, status: 400, error: `${email} is the only admin of ${team}, and a team keeps ` +
          "someone who can add the next member. Make another member admin first (member_add with role admin)." } };
      }
    }
    return { done: await write(client) };
  });
}

/** Remove a principal from a team. `confirm` must repeat the team slug exactly. */
export async function removeMember(
  id: Identity | null, team: string, email: string, confirm: string,
  extraDetail: Record<string, unknown> = {},
): Promise<TeamWriteOutcome> {
  if (!teamAuthority(id, team)) return { ok: false, status: 403, error: `team admin or superadmin required for ${team}` };
  if (confirm !== team) return { ok: false, status: 400, error: `confirm must repeat the team slug exactly ('${team}')` };
  // What was actually deleted, not what was asked for: reporting "removed" whatever happened
  // makes a mistyped address read as done while the person it was meant for stays a member.
  // COUPLED: the destructive siblings hold the same rule — team_archive refuses an inactive
  // team, pat_revoke refuses an id that is not there.
  const kept = await keepingLastAdmin(id, team, email, (q) => q.query(
    `delete from membership using team t, principal p
     where membership.team_id = t.id and membership.principal_id = p.id
       and t.slug = $1 and p.email = $2`,
    [team, email.toLowerCase()],
  ));
  if ("refused" in kept) return kept.refused;
  if (!kept.done.rowCount) {
    return { ok: false, status: 400, error:
      `${email} is not a member of ${team} — nothing was removed. Check the address: the team's members ` +
      "are listed on the console's Access page, and by person_list for a superadmin." };
  }
  auditAdmin(id, "remove_member", `${team}:${email}`, { ...extraDetail }, team);
  return { ok: true, message: `${email} removed from ${team}. ` +
    "Any access token bound to this team stops working now — it names a team they are no " +
    "longer in, and identity refuses it outright." };
}
/** Create a team (slug is the stable identity used everywhere). */
export async function createTeam(
  id: Identity | null, slug: string, rawName: string,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required" };
  // The rules for both doors, here rather than in either: the tool's schema and the console route
  // each refused differently, and neither said what a slug may be.
  if (!TEAM_SLUG.test(slug)) {
    return { ok: false, status: 400, error: `'${slug.slice(0, 80)}' is not a team slug — a slug is ${TEAM_SLUG_RULE}` };
  }
  // A name is shown wherever the team is named, and team_list hands every one to a model.
  const name = rawName.trim();
  if (!name) return { ok: false, status: 400, error: "a team's name cannot be blank — it is how every page names the team" };
  if (name.length > TEAM_NAME_MAX) {
    return { ok: false, status: 400, error: `a team's name is at most ${TEAM_NAME_MAX} characters; this one is ${name.length}` };
  }
  const db = platformDb();
  const pid = await principalId(db, id.email);
  // The platform's own team is not a tenant's to take: its store holds what we have
  // learned about the registry entries every tenant depends on, and a team owning that
  // slug would both read and write it.
  if (slug === PLATFORM_TEAM) {
    return { ok: false, status: 400,
      error: `'${PLATFORM_TEAM}' is the platform's own team and cannot be created or claimed.` };
  }
  // An archived slug is reactivated, which is why someone types team_create on it; an active one
  // is left exactly as it is, name included, and no act is recorded.
  const r = await db.query<{ existed: boolean }>(
    `insert into team (slug, name, created_by) values ($1,$2,$3)
     on conflict (slug) do update set status = 'active', name = excluded.name where team.status <> 'active'
     returning (xmax <> 0) as existed`,
    [slug, name, pid],
  );
  if (!r.rowCount) return { ok: true, message: `team ${slug} is already active — nothing changed` };
  const existed = r.rows[0].existed;
  auditAdmin(id, "create_team", slug, { reactivated: existed, ...extraDetail }, slug);
  return { ok: true, message: existed
    ? `team ${slug} was archived and is active again`
    : `team ${slug} active` };
}
/** Retire a team. `confirm` must repeat the team slug exactly. */
export async function archiveTeam(
  id: Identity | null, team: string, confirm: string,
  extraDetail: Record<string, unknown> = {},
): Promise<PlatformWriteOutcome> {
  if (!superOnly(id)) return { ok: false, status: 403, error: "superadmin required (retiring a team removes access)" };
  if (confirm !== team) return { ok: false, status: 400, error: `confirm must repeat the team slug exactly ('${team}')` };
  // team_create refuses this slug, so nothing could bring it back.
  if (team === PLATFORM_TEAM) {
    return { ok: false, status: 400, error: `'${PLATFORM_TEAM}' is the platform's own team and cannot be archived.` };
  }
  const db = platformDb();
  const r = await db.query("update team set status = 'archived' where slug = $1 and status = 'active'", [team]);
  if (!r.rowCount) return { ok: false, status: 400, error: `no active team '${team}'` };
  auditAdmin(id, "archive_team", team, { ...extraDetail }, team);
  return { ok: true, message: `team ${team} archived.\n` +
    "Its memberships and its store are kept, so team_create on the same slug restores it." };
}
