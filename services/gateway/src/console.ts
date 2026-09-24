/**
 * /api/console — the read API behind the admin console.
 *
 * Who may read it: anyone who signed in through the browser, plus a superadmin PAT. What they see
 * is answered on every route below by `resolveScope` (scope.ts) — a caller sees their own team's
 * rows unless they are a superadmin who explicitly asked for `?scope=platform`. `handler()` resolves
 * the scope once, before any handler's SQL runs, so a caller with no `?team=` cannot fall through a
 * `$1::text is null or team_slug = $1` predicate with a null standing in for "every team".
 *
 * The authority to be in the console at all is a browser session, from a passkey sign-in. A
 * superadmin PAT is also accepted so the API can be exercised with curl before any browser exists.
 *
 * A member's PAT is not accepted. A token minted for an agent is handed to a terminal, pasted into
 * config files and carried between machines; a browser session is not. Letting the two mean the
 * same thing here would make every agent token a key to every team's work.
 *
 * Narrowing this to superadmins later is a one-line change in `ok()` — /api/console/me reports what
 * the caller is rather than assuming, and the front end already renders the refusal.
 *
 * Separate from the write surface in `console-write.ts`, which resolves a scope per act. Folding a
 * cross-team read into it would put two authority models in one file.
 *
 * GET only. A read-only surface cannot be driven by a forged cross-site form, which is what lets the
 * session cookie be SameSite=Lax instead of requiring a CSRF token. Anything that writes belongs in
 * a flow, through zz-core, as the caller.
 *
 * Reads the database, not the store: the console is a fleet view — counts, means and refusal rates
 * over every team, which are SQL questions. The two knowledge endpoints here read zz.doc, which
 * carries the body already.
 *
 * Initiatives come from zz.doc, not zz.initiative. The initiative table is an index nothing has been
 * maintaining; the documents are the record, and deriving from them is what makes this API agree
 * with what people see.
 */

import type { Express } from "express";

import { mountOverview } from "./console/overview.js";
import { mountTeams } from "./console/teams.js";
import { mountInitiatives } from "./console/initiatives.js";
import { mountKnowledge } from "./console/knowledge.js";
import { mountSkills } from "./console/skills.js";
import { mountCatalog } from "./console/catalog.js";


export function mountConsole(app: Express): void {
  // The console's read API, by resource.
  mountOverview(app);
  mountTeams(app);
  mountInitiatives(app);
  mountKnowledge(app);
  mountSkills(app);
  mountCatalog(app);
}
