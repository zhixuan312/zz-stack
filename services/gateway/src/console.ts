/**
 * /api/console — the read API behind the admin console.
 *
 * Who may read it: anyone who signed in through the browser, plus a superadmin PAT. What they see
 * is answered on every team route below by `resolveScope` (scope.ts) — a caller sees their own team's
 * rows unless they are a superadmin who explicitly asked for `?scope=platform`. `handler()` resolves
 * the scope once, before any handler's SQL runs, so a caller with no `?team=` cannot fall through a
 * `$1::text is null or team_slug = $1` predicate with a null standing in for "every team".
 *
 * `/api/console/initiatives` (console/initiative-list.ts), `/api/console/approvals`,
 * `/api/console/home` (console/home.ts), `/api/console/record` (console/record.ts),
 * `/api/console/activity` and its summary (console/activity.ts), `/api/console/knowledge`, its summary
 * and a lesson by its address (console/knowledge.ts, console/knowledge-summary.ts), `/api/console/runs`
 * (console/runs.ts) and
 * `/api/console/work/query` (console/work-query.ts) resolve no scope of their own: Work is the active team's, for the superadmin too, so each answers the team the
 * identity acts for, whatever team or scope the request names. A lesson on the shared shelf opens for
 * any signed-in person by `/api/console/knowledge/zz-platform/*`, marked `shared`.
 *
 * `/api/console/access` (console/access.ts) is the caller's alone, through platformPublic: their own
 * tokens, applications, browsers and passkeys, whatever team or scope the request names.
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
 * was opened and changes nothing a page reads; `POST /api/console/platform/bugs/:id/resolve`
 * (console/platform-bug-resolve.ts), the superadmin's close of a bug report, which is zz-core's
 * `bug_resolve` called as the caller, as console-write.ts's acts are; and
 * `POST /api/console/initiatives/:team/:slug/close` (console-close.ts), a person's close of an
 * initiative of their active team, which is zz-core's `initiative_close` called the same way. A
 * cross-site form cannot drive any of them: the session cookie is SameSite=Lax, so a forged
 * cross-site POST arrives with no session and is answered 401. Anything else that writes belongs in
 * a flow, through zz-core, as the caller.
 *
 * Reads the database, not the store: the console is a fleet view — counts, means and refusal rates
 * over every team, which are SQL questions. The two knowledge endpoints here read zz.doc, which
 * carries the body already.
 *
 * One route is the exception: `/api/console/search` (console/search.ts) is zz-core's
 * `knowledge_search`, called as the caller, because ranking a question against the documents and
 * the shelf is that tool's own work and not a second implementation of it here.
 *
 * The platform's reads resolve no scope at all: `/api/console/platform/status`, `/releases`, `/bugs`,
 * `/evaluation`, `/usage`, `/knowledge` and `/audit` (console/platform-*.ts), and `/query` (console/platform-query.ts),
 * the prepared query that answers each of them, are the platform's own,
 * public by route through `platformPublic` (console/shared.ts), and answered to everybody the console
 * lets in, a person in no team included; a superadmin's answer adds only the fields each route names,
 * and a bug report, its duplicate targets and the audit are the superadmin's alone. The status read's
 * `own` part alone is the caller's active team, as the identity resolved it. `/api/console/teams`,
 * `/teams/:slug` (console/teams.ts) and `/people` (console/people.ts) are mounted the same way and are
 * the superadmin's alone: anybody else is refused before anything is read.
 *
 * An initiative's lifecycle — whether it is closed, its outcome, its flow — comes from
 * zz.initiative, the one record of it, written by initiative_open and initiative_close; the
 * documents inside an initiative remain the content record, read from zz.doc.
 */

import type { Express } from "express";

import { mountMe } from "./console/me.js";
import { mountTeams } from "./console/teams.js";
import { mountInitiatives } from "./console/initiatives.js";
import { mountKnowledge } from "./console/knowledge.js";
import { mountKnowledgeSummary } from "./console/knowledge-summary.js";
import { mountSearch } from "./console/search.js";
import { mountSkills } from "./console/skills.js";
import { mountRuns } from "./console/runs.js";
import { mountAccess } from "./console/access.js";
import { mountCatalog } from "./console/catalog.js";
import { mountPluginEval } from "./console/plugin-eval.js";
import { mountConsoleLive } from "./console/live.js";
import { mountConsoleRevision } from "./console/live-revision.js";
import { mountReadEnvelope } from "./console/read-envelope.js";
import { mountPlatformStatus } from "./console/platform-status.js";
import { mountPageView } from "./console/page-view.js";
import { mountPlatformBugResolve } from "./console/platform-bug-resolve.js";
import { mountPlatformBugs } from "./console/platform-bugs.js";
import { mountPlatformEvaluation } from "./console/platform-evaluation.js";
import { mountPlatformReleases } from "./console/platform-releases.js";
import { mountPlatformUsage } from "./console/platform-usage.js";
import { mountPlatformKnowledge } from "./console/platform-knowledge.js";
import { mountPlatformAudit } from "./console/platform-audit.js";
import { mountPeople } from "./console/people.js";
import { mountApprovals } from "./console/approvals.js";
import { mountHome } from "./console/home.js";
import { mountActivity } from "./console/activity.js";
import { mountWorkQuery } from "./console/work-query.js";
import { mountPlatformQuery } from "./console/platform-query.js";
import { mountRecord } from "./console/record.js";
import { mountConsoleClose } from "./console-close.js";


export function mountConsole(app: Express): void {
  // Every read below answered with its collection's revision, sampled before the read runs: what a page's first live
  // stream asks with (console/live-revision.ts). First, so it stands in front of every read.
  mountConsoleRevision(app);

  // Every read below answered with `observedAt`, the marker it could hear and whether its answer was kept, stamped in
  // one place before the read runs (console/read-envelope.ts). Second, so it stands in front of every read here and of
  // the settings surface `mountSettings` mounts after this function.
  mountReadEnvelope(app);

  // The console's read API, by resource.
  // Who is looking, and whether the console answers them at all; answered even to a caller it refuses elsewhere.
  mountMe(app);
  mountTeams(app);
  // People, the superadmin's read through platformPublic; a member is refused before anything is read.
  mountPeople(app);
  mountInitiatives(app);
  // Approvals: the active team's waiting queue, and the approvals signed in the caller's name with their evidence.
  mountApprovals(app);
  // Home: the active team's last whole week, what waits and what is open, the approvals in it the caller's own.
  mountHome(app);
  // Activity: the active team's refusals by owner and week, grouped, and its real-work event log with four filters.
  mountActivity(app);
  // Record: the retained text as of the cutoff, the period's work in six slices and every initiative, the approvals in it the caller's own.
  mountRecord(app);
  // Work's prepared queries: one measure of the active team by a declared dimension, against the previous window and down to a group's rows.
  mountWorkQuery(app);
  // Knowledge: the active team's shelf as of the cutoff, its own questions that found nothing, its searches by week, and the shelf paged.
  mountKnowledgeSummary(app);
  mountKnowledge(app);
  // The one read that is zz-core's answer rather than a query of this gateway's own.
  mountSearch(app);
  mountSkills(app);
  // Runs: the active team's recorded skill runs since its first, their observed output, by skill and lately.
  mountRuns(app);
  // Access: the caller's own tokens, applications, browsers, passkeys, teams and setup, never a secret; its two revokes are in settings/me.ts.
  mountAccess(app);
  mountCatalog(app);
  mountPluginEval(app);
  // The platform's own reads, public by route through platformPublic; a superadmin's answer adds only what each route names.
  mountPlatformStatus(app);
  mountPlatformReleases(app);
  // The bug queue in two projections: the safe one for everybody, the report and its duplicate targets for the superadmin.
  mountPlatformBugs(app);
  mountPlatformEvaluation(app);
  mountPlatformUsage(app);
  mountPlatformKnowledge(app);
  // The superadmin's audit: recorded administration as sentences and the latest events as metadata, never a body.
  mountPlatformAudit(app);
  // The Platform prepared query: one measure of the platform by a declared dimension or bucket, as each measure's page projects it to the caller.
  mountPlatformQuery(app);
  // The one endpoint here that is not an answer: a stream held open, which is what keeps a tab fresh without polling.
  mountConsoleLive(app);
  // A page view, which records which page was opened and is counted as nothing else.
  mountPageView(app);
  // The one act here: the superadmin's close of a bug report, which is zz-core's `bug_resolve` called as the person.
  mountPlatformBugResolve(app);
  // The person's close of an initiative of their active team, which is zz-core's `initiative_close` called as the person.
  mountConsoleClose(app);
}
