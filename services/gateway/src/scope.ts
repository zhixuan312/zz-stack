/**
 * Scope resolution — turning a caller and a request into ONE of "this team",
 * "the platform", or "refused", with no fourth state.
 *
 * The console's own SQL already has the fail-open shape this exists to rule out:
 * `where ($1::text is null or team_slug = $1)` — pass a null team and the predicate is
 * true for every row, so "no team" silently means "every team". A sibling project leaked
 * cross-team data twice from exactly that pattern before anyone read the WHERE clause
 * closely enough to notice a null was a wildcard. `Scope` has no member that means "no
 * scope" or "unset" — a caller either names a team, is granted the platform, or is
 * refused, and a switch over `.kind` that forgets a case fails to compile rather than
 * silently falling through to "everything".
 *
 * `resolveScope` is pure — no database, no `res`, nothing async — so every caller reaches
 * the same verdict from the same (Identity, Request) pair, and the ten cases in
 * scope-check.ts drive the real function rather than a description of it.
 */
import type { Request } from "express";

import { isSuper, TEAM_SLUG, type Identity } from "./identity.js";

export type Scope =
  | { kind: "team"; slug: string }
  | { kind: "platform" }
  | { kind: "refused"; status: number; error: string };

/** Decide what a request is scoped to.
 *
 * `?scope=platform` is checked FIRST and requires `isSuper`, not `platformRole` — the same
 * distinction isSuper itself draws, because a superadmin holding a team-bound PAT is not
 * meant to reach the platform through it just because the header still says "superadmin".
 * A non-superadmin sending `scope=platform` is not an error: it falls straight through to
 * the team logic below, on the theory that a UI which always sends the parameter must not
 * break for everyone who is not a superadmin, and a caller who does not have platform
 * authority gets exactly what they would have gotten without asking for it — never a
 * disclosure that the parameter exists or what it would have done.
 *
 * The team branch mirrors `requireTeam` (kb.ts:71-96), which this generalises: prefer the
 * request's own `?team=`, fall back to the identity's `activeTeam` — the ONE team a caller
 * with several is acting as, so the web view and an agent acting for the same person agree
 * on which team's data they are looking at — then validate shape with TEAM_SLUG before
 * membership, so a malformed slug gets "team must be a slug" rather than a false "not a
 * member of" for a string that was never a slug to begin with. Membership is tested with
 * `id.teams.some(t => t.slug === slug)`, exactly as requireTeam does, with the same
 * superadmin bypass — a superadmin's whole point is reading a team they do not belong to. */
export function resolveScope(id: Identity, req: Request): Scope {
  if (req.query.scope === "platform" && isSuper(id)) return { kind: "platform" };

  const slug = (req.query.team as string | undefined) ?? id.activeTeam ?? undefined;
  if (!slug) {
    return { kind: "refused", status: 400, error: "no team — join a team or pass ?team=" };
  }
  if (!TEAM_SLUG.test(slug)) {
    return { kind: "refused", status: 400, error: "team must be a slug" };
  }
  if (!id.teams.some((t) => t.slug === slug) && !isSuper(id)) {
    return { kind: "refused", status: 403, error: `not a member of ${slug}` };
  }
  return { kind: "team", slug };
}
