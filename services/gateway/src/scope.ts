/**
 * Scope resolution — turning a caller and a request into one of "this team", "the platform", or
 * "refused", with no fourth state.
 *
 * `Scope` has no member meaning "no scope" or "unset", so a switch over `.kind` that forgets a case
 * fails to compile rather than falling through to "everything". The shape this rules out is
 * `where ($1::text is null or team_slug = $1)`, where a null team means every team.
 *
 * `resolveScope` is pure — no database, no `res`, nothing async — so every caller reaches the same
 * verdict from the same (Identity, Request) pair, and the cases in scope-check.ts drive the real
 * function rather than a description of it.
 */
import type { Request } from "express";

import { isSuper, TEAM_SLUG, type Identity } from "./identity.js";

export type Scope =
  | { kind: "team"; slug: string }
  | { kind: "platform" }
  | { kind: "refused"; status: number; error: string };

/** Decide what a request is scoped to.
 *
 * `?scope=platform` is checked first and requires `isSuper`, not `platformRole` — a superadmin
 * holding a team-bound PAT is not meant to reach the platform through it. A non-superadmin sending
 * `scope=platform` is not an error: it falls through to the team logic below and gets exactly what
 * it would have got without asking, never a disclosure that the parameter exists.
 *
 * The team branch prefers the request's own `?team=` and falls back to the identity's
 * `activeTeam` — the one team a caller with several is acting as. Shape is validated with
 * TEAM_SLUG before membership, so a malformed slug gets "team must be a slug" rather than a false
 * "not a member of". A superadmin bypasses the membership test. */
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
