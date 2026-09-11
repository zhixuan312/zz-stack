/**
 * /api/console/settings — a member's own write surface (credentials, access tokens, client
 * setup, teams and block connections), a team admin's `/team/*` tier (Task I-14), and a
 * superadmin's `/platform/*` tier (Task I-15) over the whole platform — people, teams, and
 * block access.
 *
 * EVERY MEMBER ROUTE IN THIS FILE IS `/me/*` ALONE: there is no field anywhere in it a
 * caller could put someone else's name in, by construction, so there is nothing to forget
 * to guard. That is the whole of AC-4's authorisation story — not a check that could be
 * skipped, but a parameter that was never given a place to exist.
 *
 * SHARED FUNCTIONS, NOT REIMPLEMENTED ONES. The credential and access-token logic below
 * already exists as `/manage/mcp` tools in server.ts — `my_credentials`, `set_my_credential`,
 * `delete_my_credential`, `my_access_tokens`, `issue_my_access_token`, `revoke_my_access_token`
 * — written for a caller that was always an agent holding a PAT. Rather than copy their
 * queries here (and have the two drift), server.ts hands this file the SAME functions
 * through `SettingsDeps`, passed into `mountSettings` as an argument rather than imported as
 * a VALUE: server.ts already imports `mountSettings` from this file, and this file importing
 * those functions back as values would make the two modules import each other at runtime — a
 * cycle this codebase avoids everywhere else (console-write.ts depends on console.ts, never
 * the reverse). Dependency injection gets the same code reuse without that cycle. The one
 * thing this file DOES import from server.ts is `import type { ... }` for the two result
 * shapes below (`SetCredentialOutcome`, `IssueTokenOutcome`) — a type-only import, erased
 * entirely by `tsc` before anything runs, so it creates no runtime edge and no cycle; it is
 * there only so this file's own signatures do not restate those shapes a second time.
 *
 * `via: "web"` IS ADDED HERE, AT THE CALL SITE, never inside the shared function. Every
 * `my_*` function's own `logEvent` call carries no door marker — an agent's chat turn and a
 * browser's button press both reach the same function today, and neither should inherit a
 * marker that only describes one of them. Each write route below passes `{ via: "web" }` as
 * the shared function's last argument, which is merged into that one `logEvent` call's
 * `detail`. See gate.mjs's "every console write route records the door it came through" —
 * extended for Task I-13 to recognise this pattern (the marker inside the call to a named
 * shared function, not only inside a literal `logEvent(...)` in the route body).
 *
 * TASK I-14's team routes import `addMember`, `removeMember`, `installFlow` and
 * `uninstallFlow` from admin.js AS VALUES, unlike the `my_*` functions above — admin.ts
 * never imports this file, so there is no cycle here for dependency injection to avoid. Its
 * `teamAuthority` is imported the same way, so this file's team routes and add_member's own
 * `on conflict` insert both drive the identical check identity.ts computes; a re-implemented
 * comparison here would still pass the gate's own cases while quietly drifting from the real
 * rule. `set_team_credential`/`delete_team_credential`, though, live in server.ts — the
 * cycle DOES apply to those, so they arrive through `SettingsDeps` exactly like the `my_*`
 * functions. Every team write below is validated by `teamAuthority` inside the shared
 * function itself, not by `resolveScope`: a team admin managing this surface is not
 * necessarily ACTING FOR the team they administer (they may administer several), so the
 * team is named explicitly in the request rather than read off the caller's active scope.
 *
 * REDACTED EVERYWHERE BUT TWO PLACES. Every response in this file is wrapped in `redact()`
 * (redact.ts) except the two that hand back a live credential exactly once: `POST /me/tokens`
 * returns a freshly issued access token, and `POST /platform/enrolments` returns a one-time
 * passkey enrolment link. Both would otherwise report success while handing back a marker,
 * which is the worst of both. Each route's own comment says why the exemption belongs there
 * and nowhere else.
 */
import type { Express } from "express";

import type { IssueTokenOutcome, SetCredentialOutcome } from "./credentials.js";
import { type Identity } from "./identity.js";
import { mountMySettings } from "./settings/me.js";
import { mountTeamSettings } from "./settings/team.js";
import { mountPlatformSettings } from "./settings/platform.js";

/**
 * The `my_*` functions this file reuses rather than reimplements — handed in by server.ts,
 * which is where they are defined (see this file's header for why they arrive as an
 * argument instead of an import). Every write here takes an optional trailing
 * `extraDetail`, merged into that function's own `logEvent` call; every route below passes
 * `{ via: "web" }`.
 */
export interface SettingsDeps {
  myCredentialsFor: (email: string) => Record<string, string>;
  setMyCredentialFor: (
    email: string, platform: string, apiKey: string, extraDetail?: Record<string, unknown>,
  ) => Promise<SetCredentialOutcome>;
  deleteMyCredentialFor: (email: string, platform: string, extraDetail?: Record<string, unknown>) => Promise<boolean>;
  myAccessTokensFor: (email: string) => Promise<Array<{
    id: string; label: string; scope: string; created_at: string; last_used_at: string | null; revoked_at: string | null;
  }>>;
  issueMyAccessTokenFor: (
    email: string, label: string | undefined, extraDetail?: Record<string, unknown>,
  ) => Promise<IssueTokenOutcome>;
  revokeMyAccessTokenFor: (email: string, id: string, extraDetail?: Record<string, unknown>) => Promise<boolean>;
}

/** The caller's teams, and which one they act for — the same rule `my_teams` (server.ts)
 *  answers over MCP, pure enough (it only reads the `Identity` the middleware already
 *  resolved) to live here and be imported by server.ts rather than the other way round. */
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
      ? { note: `Your token is BOUND to ${id.activeTeam}, so switch_team cannot move it. ` +
                `A token bound to a team is what makes it safe to leave running.` }
      : teams.length > 1
      ? { note: `switch_team moves you to another one. You act for exactly one team at a ` +
                `time, so switching changes what every client shows you — including which ` +
                `agents you have.` }
      : {}),
  };
}

export function mountSettings(app: Express, deps: SettingsDeps): void {
  /** Which platforms the caller has stored a personal key for — never the value, not even
   *  masked. `myCredentialsFor` returns the RAW keys (an agent-facing caller masks them;
   *  server.ts's own `my_credentials` tool does exactly that) — this route instead reshapes
   *  them into `{ platform, api_key }` rows and lets `redact()` do the hiding, so the
   *  guarantee that a browser never sees a fragment of a key comes from the same field-name
   *  rule every other secret in this console goes through, rather than a second masking
   *  scheme this file would have to keep in step with `mask()`. */
  // THE THREE SCOPES, and the boundary between them is the authorisation.
  mountMySettings(app, deps);
  mountTeamSettings(app);
  mountPlatformSettings(app);
}
