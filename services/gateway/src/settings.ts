/**
 * /api/console/settings — a member's own write surface (access tokens, client setup and the
 * team they act for), a team admin's `/team/*` tier, and a superadmin's `/platform/*` tier over
 * people and teams.
 *
 * Every member route is `/me/*` alone: there is no field a caller could put someone else's name
 * in, so there is nothing to guard.
 *
 * The credential and access-token logic already exists as `/manage/mcp` tools. server.ts hands
 * this file the same functions through `SettingsDeps`, passed into `mountSettings` as an
 * argument rather than imported as a value: server.ts imports `mountSettings` from here, so
 * importing back as values would make the two modules import each other at runtime. The only
 * import from server.ts is `import type` for the result shapes, erased by `tsc`.
 *
 * `via: "web"` is added at the call site, never inside the shared function: an agent's chat turn
 * and a browser's button press reach the same function, and neither should inherit the other's
 * marker. Each write route passes `{ via: "web" }` as the last argument, merged into that
 * function's `logEvent` detail. COUPLED: the gate's "every console write route records the door
 * it came through" recognises this pattern as well as a literal `logEvent(...)` in a route body.
 *
 * The team routes import `addMember`, `removeMember` and `teamAuthority` from admin.js as
 * values, since admin.ts never imports this file. Every team write is validated by
 * `teamAuthority` inside the shared function, not by `resolveScope`: a team admin managing this
 * surface is not necessarily acting for the team they administer, so the team is named
 * explicitly in the request rather than read off the caller's active scope.
 *
 * Every response is wrapped in `redact()` (redact.ts) except the two that hand back a live
 * credential exactly once: `POST /me/tokens` returns a freshly issued access token, and
 * `POST /platform/enrolments` returns a one-time passkey enrolment link.
 */
import type { Express } from "express";

import type { IssueTokenOutcome } from "./credentials.js";
import { type Identity } from "./identity.js";
import { mountMySettings } from "./settings/me.js";
import { mountTeamSettings } from "./settings/team.js";
import { mountPlatformSettings } from "./settings/platform.js";

/**
 * The `my_*` functions this file reuses rather than reimplements, handed in by server.ts. Every
 * write takes an optional trailing `extraDetail`, merged into that function's own `logEvent`
 * call; every route below passes `{ via: "web" }`.
 */
export interface SettingsDeps {
  myAccessTokensFor: (email: string) => Promise<Array<{
    id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null;
  }>>;
  issueMyAccessTokenFor: (
    email: string, label: string | undefined, extraDetail?: Record<string, unknown>,
  ) => Promise<IssueTokenOutcome>;
  revokeMyAccessTokenFor: (email: string, id: string, extraDetail?: Record<string, unknown>) => Promise<boolean>;
}

/** The caller's teams, and which one they act for — the same rule `team_mine` (server.ts)
 *  answers over MCP. It only reads the `Identity` the middleware resolved, so it lives here and
 *  server.ts imports it rather than the other way round. */
export function myTeamsSummary(id: Identity):
  | { ok: true; actingFor: string; teams: { team: string; role: string; active: boolean }[]; note?: string }
  | { ok: false; error: string } {
  if (!id.teams.length) return { ok: false, error: "you are not in any team yet — ask an admin to add you" };
  const teams = [...id.teams].sort((a, b) => a.slug.localeCompare(b.slug));
  // A bound token naming a team its owner is not in resolves to nothing, and saying so is
  // the whole point of the binding — a fallback here would be the wandering it prevents.
  if (!id.activeTeam) {
    return { ok: false, error: `your token is bound to team '${id.patTeam}', which you are not a ` +
                    `member of, so it acts for no team. Yours: ${teams.map((t) => t.slug).join(", ")}.` };
  }
  const bound = id.patTeam ? id.patTeam === id.activeTeam : false;
  return {
    ok: true,
    actingFor: id.activeTeam,
    teams: teams.map((t) => ({ team: t.slug, role: t.role, active: t.slug === id.activeTeam })),
    ...(bound
      ? { note: `Your token is BOUND to ${id.activeTeam}, so team_switch cannot move it. ` +
                `A token bound to a team is what makes it safe to leave running.` }
      : teams.length > 1
      ? { note: `team_switch moves you to another one. You act for exactly one team at a ` +
                `time, so switching changes what every client shows you — including which ` +
                `agents you have.` }
      : {}),
  };
}

export function mountSettings(app: Express, deps: SettingsDeps): void {
  // The three scopes, and the boundary between them is the authorisation.
  mountMySettings(app, deps);
  mountTeamSettings(app);
  mountPlatformSettings(app);
}
