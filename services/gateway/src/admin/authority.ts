/** Who may administer what.
 *
 *  Two predicates and two lookups. The predicates are the whole authorisation model for
 *  administration: `superOnly` is the platform, `teamAuthority` is one team. "Administers some
 *  team" is not "administers this team" — a team admin asking about another team's people is
 *  answered no. */
import pg from "pg";

import { isSuper, isTeamAdmin, type Identity } from "../identity.js";

// COUPLED: the scope-aware checks in identity.ts, never a second pair that ignores scope — a
// local copy reading only platformRole gives a member-scope token its owner's whole superadmin
// authority. settings.ts's `/api/console/settings/platform/*` routes and scope-check.ts's
// authority matrix both drive this function.
export const superOnly = (id: Identity | null): id is Identity => !!id && isSuper(id);
// COUPLED: settings.ts's `/api/console/settings/team/*` routes and scope-check.ts's authority
// matrix both drive this function. isTeamAdmin is where "a superadmin is every team" and "a
// team-bound PAT is refused everywhere but its own team" are decided.
export const teamAuthority = (id: Identity | null, slug: string): id is Identity =>
  !!id && isTeamAdmin(id, slug);
export async function principalId(db: pg.Pool, email: string): Promise<string | null> {
  const r = await db.query<{ id: string }>("select id from principal where email = $1", [email.toLowerCase()]);
  return r.rows[0]?.id ?? null;
}
/** The id of an active team, or null. Returning an archived team lets member_add and pat_issue
 *  write rows that resolve to nothing, because every identity query filters on status — the tool
 *  reports success and the person gets no team. */
export async function teamId(db: pg.Pool, slug: string): Promise<string | null> {
  const r = await db.query<{ id: string; status: string }>(
    "select id, status from team where slug = $1", [slug]);
  const row = r.rows[0];
  return row && row.status === "active" ? row.id : null;
}
