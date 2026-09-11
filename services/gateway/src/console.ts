/**
 * /api/console — the read API behind the admin console.
 *
 * WHO MAY READ IT: anyone who signed in through the browser, plus a superadmin PAT. WHAT THEY
 * SEE is a separate question, answered on every route below by `resolveScope` (scope.ts):
 * a caller sees their own team's rows unless they are a superadmin who explicitly asked
 * for `?scope=platform`, in which case they see the whole fleet. Those two used to be the
 * same door — anyone who could sign in saw every team's work, because a caller with no
 * `?team=` fell through `$1::text is null or team_slug = $1`, a null standing in for
 * "every team". `handler()` resolves the scope once, before any handler's SQL runs, so
 * that shape cannot reappear one query at a time.
 *
 * The authority to be IN the console at all is still *being in the corporate directory*
 * — SsoAuth is the fence, and this door trusts it. A superadmin PAT is also accepted so
 * the API can be exercised with curl before any browser exists, and so a scripted check
 * never needs a session cookie.
 *
 * What is NOT accepted is a member's PAT. A token minted for an agent is handed
 * to a terminal, pasted into config files and carried between machines; a
 * directory sign-in is not. Letting the two mean the same thing here would make
 * every agent token on the platform a key to every team's work, which is the
 * one property the identity port exists to keep separable.
 *
 * Narrowing this to superadmins later is a one-line change in `ok()` — the
 * front end already renders the refusal, because /api/console/me reports what
 * the caller is rather than assuming.
 *
 * This is a separate namespace from /api/kb because /api/kb is a MEMBER's view
 * of their OWN team, bound by `requireTeam`. Folding a cross-team view into it
 * would put two authority models in one file, where the narrower one is easy
 * to lose.
 *
 * GET ONLY, deliberately. A read-only surface cannot be driven by a forged
 * cross-site form, which is what lets the session cookie be SameSite=Lax
 * instead of requiring a CSRF token on day one. Anything that writes belongs in
 * a flow, through zz-core, as the caller — the same rule the knowledge base
 * follows.
 *
 * READS THE DATABASE, NOT THE STORE. The console is a fleet view: counts, means
 * and refusal rates over every team, which are SQL questions. /api/kb reads the
 * artifacts volume because it serves one team's document bodies; the two
 * knowledge endpoints here are the exception and they read zz.doc, which
 * carries the body already.
 *
 * INITIATIVES COME FROM zz.doc, NOT zz.initiative. The initiative table is
 * stale — on production it lists ten slugs that predate the work now in the
 * store, and none of the initiatives people actually ran this month. The
 * documents are the record; the table is an index nothing has been maintaining.
 * Deriving from zz.doc is what makes this API agree with what people see.
 */

import type { Express } from "express";

import { mountOverview } from "./console/overview.js";
import { mountTeams } from "./console/teams.js";
import { mountInitiatives } from "./console/initiatives.js";
import { mountKnowledge } from "./console/knowledge.js";
import { mountSkills } from "./console/skills.js";
import { mountCatalog } from "./console/catalog.js";


export function mountConsole(app: Express): void {
  // THE CONSOLE'S READ API, by resource.
  mountOverview(app);
  mountTeams(app);
  mountInitiatives(app);
  mountKnowledge(app);
  mountSkills(app);
  mountCatalog(app);
}
