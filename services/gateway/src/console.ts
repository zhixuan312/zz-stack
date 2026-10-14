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
 * GET only, but for `POST /api/console/page-view` (console/page-view.ts), which records which page
 * was opened and changes nothing a page reads, and `POST /api/console/platform/bugs/:id/resolve`
 * (console/platform-bug-resolve.ts), the superadmin's close of a bug report, which is zz-core's
 * `bug_resolve` called as the caller, as console-write.ts's acts are. A cross-site form cannot drive
 * either: the session cookie is SameSite=Lax, so a forged cross-site POST arrives with no session and
 * is answered 401. Anything else that writes belongs in a flow, through zz-core, as the caller.
 *
 * Reads the database, not the store: the console is a fleet view — counts, means and refusal rates
 * over every team, which are SQL questions. The two knowledge endpoints here read zz.doc, which
 * carries the body already.
 *
 * One route is the exception: `/api/console/search` (console/search.ts) is zz-core's
 * `knowledge_search`, called as the caller, because ranking a question against the documents and
 * the shelf is that tool's own work and not a second implementation of it here.
 *
 * One route resolves no scope at all: `/api/console/platform/status` (console/platform-status.ts)
 * is the platform's own health, public by route through `platformPublic` (console/shared.ts), and
 * answered alike to everybody the console lets in, a person in no team included.
 *
 * An initiative's lifecycle — whether it is closed, its outcome, its flow — comes from
 * zz.initiative, the one record of it, written by initiative_open and initiative_close; the
 * documents inside an initiative remain the content record, read from zz.doc.
 */

import type { Express } from "express";

import { mountOverview } from "./console/overview.js";
import { mountTeams } from "./console/teams.js";
import { mountInitiatives } from "./console/initiatives.js";
import { mountKnowledge } from "./console/knowledge.js";
import { mountSearch } from "./console/search.js";
import { mountSkills } from "./console/skills.js";
import { mountCatalog } from "./console/catalog.js";
import { mountPluginEval } from "./console/plugin-eval.js";
import { mountConsoleLive } from "./console/live.js";
import { mountPlatformStatus } from "./console/platform-status.js";
import { mountPageView } from "./console/page-view.js";
import { mountPlatformBugResolve } from "./console/platform-bug-resolve.js";


export function mountConsole(app: Express): void {
  // The console's read API, by resource.
  mountOverview(app);
  mountTeams(app);
  mountInitiatives(app);
  mountKnowledge(app);
  // The one read that is zz-core's answer rather than a query of this gateway's own.
  mountSearch(app);
  mountSkills(app);
  mountCatalog(app);
  mountPluginEval(app);
  // The one read answered alike to everybody the console lets in: public by route, through platformPublic.
  mountPlatformStatus(app);
  // The one endpoint here that is not an answer: a stream held open, which is what keeps a tab fresh without polling.
  mountConsoleLive(app);
  // A page view, which records which page was opened and is counted as nothing else.
  mountPageView(app);
  // The one act here: the superadmin's close of a bug report, which is zz-core's `bug_resolve` called as the person.
  mountPlatformBugResolve(app);
}
