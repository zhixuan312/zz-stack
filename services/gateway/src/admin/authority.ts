/**
 * Who may administer what.
 *
 * Two predicates and two lookups, and the two predicates are the whole authorisation model
 * for administration: `superOnly` is the platform, `teamAuthority` is one team. They are
 * separate because "administers some team" is not "administers THIS team" — a team admin
 * asking about another team's people is answered no, and a check holds that.
 */
import pg from "pg";

import { isSuper, isTeamAdmin, type Identity } from "../identity.js";

// The scope-aware checks in identity.ts, not a second pair that ignores it. These were
// local copies reading only platformRole, so a token issued deliberately as member-scope
// carried its owner's whole superadmin authority — proven with a self-issued member token
// that successfully called tool_grant, which is superadmin-only.
// Exported for Task I-15: settings.ts's `/api/console/settings/platform/*` routes and
// scope-check.ts's authority matrix both drive this SAME function rather than a copy of the
// comparison — the same reason `teamAuthority` just below is exported.
export const superOnly = (id: Identity | null): id is Identity => !!id && isSuper(id);
// Exported for Task I-14: settings.ts's `/api/console/settings/team/*` routes and
// scope-check.ts's authority matrix both drive this SAME function rather than a copy of the
// comparison — see identity.ts's own header for why isTeamAdmin, not a second spelling of
// it, is where "a superadmin is every team" and "a team-bound PAT is refused everywhere but
// its own team" are decided.
export const teamAuthority = (id: Identity | null, slug: string): id is Identity =>
  !!id && isTeamAdmin(id, slug);
export async function principalId(db: pg.Pool, email: string): Promise<string | null> {
  const r = await db.query<{ id: string }>("select id from principal where email = $1", [email.toLowerCase()]);
  return r.rows[0]?.id ?? null;
}
/** The id of an ACTIVE team, or null.
 *
 * This returned any team, archived included, and every caller then acted on it. flow_install
 * was the worst of them: projecting a preset re-created the front end's own group, so
 * installing a flow for an archived team handed the browser back the access team_archive had
 * just taken away. That projection is gone with the front end that needed it, and the rule it
 * broke is the reason this filters. member_add and pat_issue wrote
 * rows that resolve to nothing, because every identity query filters on status — so the tool
 * reported success and the person got no team, and a token that carries none. */
export async function teamId(db: pg.Pool, slug: string): Promise<string | null> {
  const r = await db.query<{ id: string; status: string }>(
    "select id, status from team where slug = $1", [slug]);
  const row = r.rows[0];
  return row && row.status === "active" ? row.id : null;
}
