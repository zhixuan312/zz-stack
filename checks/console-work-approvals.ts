#!/usr/bin/env node
/**
 * checks/console-work-approvals.ts — Approvals answers the active team's waiting queue and the
 * caller's own approvals with their evidence, through a real zz-core on a throwaway database.
 *
 *   node checks/console-work-approvals.ts   # needs Docker and a built tree (`npm run build`)
 *
 * Two people on one team, the seeded one (A) and `member()` (B). Every document, presentation and
 * approval is made through zz-core's tools or the gateway's own console routes; the check then makes
 * only the direct writes the plan allows a check, each on rows it made itself: moving an initiative's
 * timestamps together, by whole days or onto one instant, deleting the presentation rows of one approval's context (a
 * context that covered nothing of the revision), deleting one approval's event (a revision sealed
 * before the events began), and dropping the review context and content revision from one approval's
 * event (an approval recorded before those keys were). What it establishes, values written here:
 *
 *   - Waiting is the team's queue: the two specs presented and not approved, oldest wait first, each
 *     once with its version, content revision and the time it has waited, labelled `team`, the same
 *     rows `pendingRevisions` answers for the team, one of them older than 14 days, alike to both;
 *   - History is A's eleven approvals and nothing of B's, newest first, each with its version, content
 *     revision and time (a day alone for the one sealed before the events), its presentation and its
 *     decision basis: shown in the console, covered in an agent's context, a context that covered
 *     nothing, and unknown; explicit, delegation and unknown;
 *   - a console presentation seconds before an agent's approval in another context is not shown, and a
 *     revision presented again after a newer one was approved is not labelled by the newer one;
 *   - an approval B signed on A's behalf is A's, and one A signed on B's behalf is B's; B reads none of
 *     A's approvals in History or the tiles; the console's own `document.approve` row is never counted,
 *     and neither is one a maintenance client (`zz-migrate`) signed in A's name, in History, the tiles,
 *     the weeks or the exported reads;
 *   - the tiles count waiting, the oldest wait, A's approvals and those with no presentation recorded
 *     of those since review contexts were recorded, and a list that cannot be read leaves its own tiles
 *     null; approvals by week count each one once, in the reporting timezone's week: one made at 06:00
 *     on a Monday in Asia/Singapore, still the Sunday before in UTC, is that Monday's (the third
 *     re-review's Work P-1);
 *   - `tab` pages its own list while the other answers its first ten rows and its total; a tab, a page
 *     or a parameter the route does not take is 400; `?scope=platform` widens nothing;
 *   - `callerApprovals` and `callerApprovalRows` answer the same approvals by month and by span;
 *   - every answer agrees in shape with the console's fake one, key set by key set.
 *
 * Exit 0: every case held. Exit 1: a case failed, named. Exit 2: Docker is not available — not a pass.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { WEEK, runningWeek } from "../scripts/schema/work-seed.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const NAME = "console-work-approvals";
const DONE = "console-work-approvals: Waiting is the team's queue and History the caller's own approvals with their " +
  "presentation and decision basis, read by context and snapshot and never by time, counted once by week, paged by " +
  "tab, in the fake's shapes: ok";
const TIMEZONE = "Asia/Singapore";
const HOUR = 3_600_000;
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-approvals.ts");
const BODY = "# Notes\n\n## Alpha\n\nalpha line one\n\n## Beta\n\nbeta line one\n";
const EXPLORE = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";
const SPEC = "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n" +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Row = { initiative: string; path: string; version: number; contentRevision: string; approvedAt: string; presentation: string; decisionBasis: string };
/** An approval the check expects, with the instant it is placed at. */
type Want = Row & { atMs: number };
type Answer = { status: number; body: Obj };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const json = (v: unknown): string => JSON.stringify(v);

/** A console session's request, past the gateway's middleware (COUPLED: identity.ts, which stamps
 *  these headers; the console's write routes forward exactly them to zz-core). */
function sessionRequest(c: Core, body: Obj): Obj {
  return {
    params: {}, query: { team: c.team }, body,
    zzIdentity: { email: c.email, displayName: "Skeleton", platformRole: "member", via: "session",
                  teams: [{ slug: c.team, role: "admin" }], activeTeam: c.team, patTeam: null, sessionTeam: c.team, origin: "work" },
    headers: { "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "", "x-zz-user-role": "user",
               "x-zz-via": "session", "x-zz-pat-team": "", "x-zz-session-team": c.team },
  };
}

/** Calls one mounted write route as Express would, and waits for its answer. */
function called(route: Route, req: Obj): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Obj) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

async function run(c: Core): Promise<void> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  type Span = { from: string; to: string };
  const gw = (await load("services/gateway/dist/console/approvals.js")) as {
    mountApprovals: (app: Express) => void;
    callerApprovals: (team: string, caller: string, span: Span, asOf: string, grain: string) => Promise<{ periods: Obj[]; total: number }>;
    callerApprovalRows: (team: string, caller: string, span: Span, asOf: string) => Promise<Row[]>;
  };
  const { pendingRevisions } = (await load("services/gateway/dist/console/pending.js")) as
    { pendingRevisions: (asOf: string) => Promise<{ team: string; initiative: string; path: string; presentedMs: number }[]> };
  const { mountConsoleWrite } = (await load("services/gateway/dist/console-write.js")) as { mountConsoleWrite: (app: unknown) => void };
  const writes = new Map<string, Route>();
  mountConsoleWrite({ post: (path: string, h: Route) => writes.set(path, h) });

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  gw.mountApprovals(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/approvals`;

  const A = c.email;
  const B = await c.member();
  const cookie = { [A]: await signIn(c.sql, A), [B]: await signIn(c.sql, B) };
  const read = async (who: string, query = ""): Promise<Answer> => {
    const res = await fetch(`${base}${query}`, { headers: { cookie: `zz_console=${cookie[who]}` }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body };
  };
  const agentB = c.client({ email: B });
  const session = c.client({ via: "session" });

  /** zz-core's own content revision of a document's current snapshot. */
  const tokenOf = async (path: string): Promise<string> => {
    const reply = await c.ok(`read ${path}`, "document_read", { path });
    return /^content_revision: (cr_[a-z2-7]{26})$/m.exec(reply)?.[1] ?? c.fail(`read ${path}`, `no content_revision in: ${reply}`);
  };
  /** A freeform initiative holding one written document: its path. */
  const doc = async (slug: string): Promise<string> => {
    const initiative = await c.open(slug);
    await c.ok(`write ${slug}`, "document_write", { path: `${initiative}/notes.md`, content: BODY });
    return `${initiative}/notes.md`;
  };
  /** Present and approve as `via`'s caller, with `extra` arguments: the content revision approved. */
  const sign = async (path: string, extra: Obj = {}, via?: ReturnType<Core["client"]>): Promise<string> => {
    const token = await tokenOf(path);
    await c.ok(`present ${path}`, "document_present", { path }, via);
    await c.ok(`approve ${path}`, "document_approve", { path, ...extra }, via);
    return token;
  };
  /** Shown and approved through the console's own routes, as A's browser session: the content revision. */
  const consoleSign = async (path: string): Promise<string> => {
    const [initiative, name] = path.split("/");
    const token = await tokenOf(path);
    const shown = await called(writes.get("/api/console/documents/shown")!, sessionRequest(c, { initiative, path: name, content_revision: token }));
    if (shown.status !== 200) c.fail(`console shown ${path}`, json(shown.body));
    const ok = await called(writes.get("/api/console/documents/approve")!, sessionRequest(c, {
      initiative, path: name, expected_revision: token, review_context: shown.body.review_context }));
    if (ok.status !== 200) c.fail(`console approve ${path}`, json(ok.body));
    return token;
  };
  /** Moves every timestamp of an initiative back by `by`, an interval (`7 days`), together. */
  const shift = async (path: string, by: string): Promise<void> => {
    const slug = path.split("/")[0];
    await c.sql.query("update zz.event set ts = ts - $2::interval where initiative_id = (select id from zz.initiative where slug = $1)", [slug, by]);
    await c.sql.query(
      `update zz.doc_revision r set written_at = r.written_at - $2::interval, approved_at = r.approved_at - $2::interval,
              presented_at = r.presented_at - $2::interval
         from zz.doc d join zz.initiative i on i.id = d.initiative_id where r.doc_id = d.id and i.slug = $1`, [slug, by]);
    await c.sql.query("update zz.initiative set opened_at = opened_at - $2::interval where slug = $1", [slug, by]);
  };
  /** The approval events of one document, oldest first. */
  const approvalEvents = async (path: string): Promise<{ id: string; ms: number; context: string | null }[]> =>
    (await c.sql.query<{ id: string; ms: number; context: string | null }>(
      `select id::text as id, (extract(epoch from ts) * 1000)::float8 as ms, detail->>'review_context' as context
         from zz.event where kind = 'document.document_approve' and subject = $1 order by ts, id`, [path])).rows;

  try {
    let step = "the record is made through zz-core";
    // The queue: two specs presented and not approved, one waiting 15 days.
    const queue: { path: string; token: string }[] = [];
    for (const slug of ["waits-long", "waits-short"]) {
      const initiative = await c.open(slug, "sdlc-flow");
      await c.ok(step, "document_write", { path: `${initiative}/explore.md`, content: EXPLORE });
      await c.ok(step, "document_write", { path: `${initiative}/spec.md`, content: SPEC });
      await c.ok(step, "document_present", { path: `${initiative}/spec.md` });
      queue.push({ path: `${initiative}/spec.md`, token: await tokenOf(`${initiative}/spec.md`) });
    }
    await shift(queue[0].path, "15 days");

    const want: Want[] = [];
    const expect = (path: string, version: number, token: string, presentation: string, decisionBasis: string): void => {
      const [initiative, name] = path.split("/");
      want.push({ initiative, path: name, version, contentRevision: token, approvedAt: "", presentation, decisionBasis, atMs: 0 });
    };
    // Shown in the console and approved there, which records explicit; its own `document.approve` beside it.
    const shownHere = await doc("shown-here");
    expect(shownHere, 1, await consoleSign(shownHere), "console_revision_shown", "explicit_recorded");
    // Covered in an agent's context, under a recorded delegation; a week back.
    const delegated = await doc("delegated");
    expect(delegated, 1, await sign(delegated, { decision_basis: "delegation" }), "agent_context_covered", "standing_delegation_recorded");
    // Shown in the console seconds before an agent's approval in another context: not shown.
    const apart = await doc("seconds-apart");
    const shown = await c.ok(step, "document_shown", { path: apart, content_revision: await tokenOf(apart) }, session);
    if (!/Review context: rc_/.test(shown)) c.fail(step, `the console presentation was not recorded: ${shown}`);
    expect(apart, 1, await sign(apart), "agent_context_covered", "unknown");
    // v1 approved by an agent, v2 shown and approved in the console, then v1 presented again.
    const again = await doc("presented-again");
    expect(again, 1, await sign(again), "agent_context_covered", "unknown");
    await c.ok(step, "document_edit", { path: again, edits: [{ find: "alpha line one", replace: "alpha line two" }], source_content: "a second look" });
    expect(again, 2, await consoleSign(again), "console_revision_shown", "explicit_recorded");
    await c.ok(step, "document_present", { path: again, version: 1 });
    // Signed by B on A's behalf: A's.
    const forA = await doc("signed-for-a");
    expect(forA, 1, await sign(forA, { on_behalf_of: A }, agentB), "agent_context_covered", "unknown");
    // Its context's presentation rows lost: a context that covered nothing of the revision.
    const lost = await doc("context-lost");
    expect(lost, 1, await sign(lost), "not_recorded", "unknown");
    // Recorded before approvals named their context and snapshot.
    const unnamed = await doc("unnamed");
    expect(unnamed, 1, await sign(unnamed), "unknown", "unknown");
    // Sealed before the events began: read from the revision, dated by its day.
    const sealed = await doc("sealed-before");
    expect(sealed, 1, await sign(sealed), "unknown", "unknown");
    for (const slug of ["plain-one", "plain-two"]) {
      const p = await doc(slug);
      expect(p, 1, await sign(p), "agent_context_covered", "unknown");
    }
    // B's own, and one A signed for B: neither is A's.
    const forB = await doc("signed-for-b");
    await sign(forB, { on_behalf_of: B });
    const bOwn = await doc("b-own");
    await sign(bOwn, {}, agentB);
    // Signed in A's name by a maintenance client: no approval of A's.
    const carried = await doc("carried-in");
    await sign(carried, {}, c.client({ client: "zz-migrate" }));

    await shift(delegated, "7 days");
    // Onto 06:00 on the Monday two weeks back in the reporting timezone, still the Sunday before in UTC: a
    // week cut on UTC's calendar would count it a week early.
    const early = runningWeek(Date.now()) - 2 * WEEK + 6 * HOUR;
    await shift(apart, `${((await approvalEvents(apart))[0].ms - early) / 1000} seconds`);
    const lostContext = (await approvalEvents(lost))[0].context;
    await c.sql.query("delete from zz.event where kind in ('document.shown', 'document.shown_part') and detail->>'review_context' = $1", [lostContext]);
    await c.sql.query("update zz.event set detail = detail - 'review_context' - 'content_revision' where kind = 'document.document_approve' and subject = $1", [unnamed]);
    await shift(sealed, "60 days");
    await c.sql.query("delete from zz.event where kind = 'document.document_approve' and subject = $1", [sealed]);
    // The console's Approve logs its own row after answering.
    for (let i = 0; i < 100 && !(await c.sql.query("select 1 from zz.event where kind = 'document.approve'")).rowCount; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!(await c.sql.query("select 1 from zz.event where kind = 'document.approve'")).rowCount) c.fail(step, "the console wrote no document.approve row");
    const maintained = await c.sql.query(
      "select 1 from zz.event where kind = 'document.document_approve' and subject = $1 and origin = 'platform' and lower(detail->>'signer') = lower($2)",
      [carried, A]);
    if (maintained.rowCount !== 1) c.fail(step, "the maintenance client's approval was not recorded in A's name as maintenance, so its absence would prove nothing");

    // Each expected approval's time, read from the record it was moved to.
    const seen = new Map<string, number>();
    for (const w of want) {
      const path = `${w.initiative}/${w.path}`;
      if (path === sealed) {
        const { rows } = await c.sql.query<{ day: string }>(
          `select to_char(r.approved_at, 'YYYY-MM-DD') as day from zz.doc_revision r join zz.doc d on d.id = r.doc_id
             join zz.initiative i on i.id = d.initiative_id where i.slug = $1 and r.approved_at is not null`, [w.initiative]);
        w.approvedAt = rows[0].day;
        w.atMs = Date.parse(`${rows[0].day}T00:00:00+08:00`);
        continue;
      }
      const n = seen.get(path) ?? 0;
      seen.set(path, n + 1);
      w.atMs = (await approvalEvents(path))[n].ms;
      w.approvedAt = iso(w.atMs);
    }
    want.sort((a, b) => b.atMs - a.atMs);
    const rows = want.map(({ atMs: _, ...r }) => r);
    // The route's cutoff is the whole second it reads in; read from the next one, so it covers everything made.
    await new Promise((r) => setTimeout(r, 1100));
    c.pass("the record is made: two specs waiting, eleven approvals in A's name, two in B's and one a maintenance client signed in A's name");

    step = "Waiting is the team's queue";
    const asOf = new Date().toISOString();
    const pending = (await pendingRevisions(asOf)).filter((p) => p.team === c.team);
    const mine = await read(A);
    if (mine.status !== 200) c.fail(step, `A's read answered ${mine.status}: ${json(mine.body)}`);
    const waiting = mine.body.waiting as Obj;
    const wData = waiting.data as Obj;
    const wantQueue = queue.map((q, i) => ({
      initiative: q.path.split("/")[0], path: "spec.md", version: 1, contentRevision: q.token,
      waitingSince: iso(pending[i]?.presentedMs ?? 0),
    }));
    if (pending.map((p) => `${p.initiative}/${p.path}`).join() !== queue.map((q) => q.path).join()) {
      c.fail(step, `pendingRevisions answers ${json(pending)} for the team`);
    }
    if (waiting.state !== "ok" || json(wData.rows) !== json(wantQueue) || wData.total !== 2 || wData.queue !== "team") {
      c.fail(step, `waiting is ${json(waiting)}, expected rows ${json(wantQueue)}`);
    }
    const wSummary = wData.summary as Obj;
    if (wSummary.olderThan14Days !== 1 || (wSummary.byInitiative as unknown[]).length !== 2) c.fail(step, `summary ${json(wSummary)}`);
    const theirs = await read(B);
    if (json((theirs.body.waiting as Obj).data) !== json(wData)) c.fail(step, `B reads another queue: ${json(theirs.body.waiting)}`);
    c.pass("Waiting answers the team's two pending specs, oldest wait first, each once with its version, content revision and " +
      "wait, labelled team, pendingRevisions' rows for the team, one older than 14 days, alike to both people");

    step = "History is A's approvals with their evidence";
    const history = (await read(A, "?tab=history&limit=100")).body.history as Obj;
    const hData = history.data as Obj;
    if (history.state !== "ok" || hData.total !== 11) c.fail(step, `history is ${json(history)}`);
    for (let i = 0; i < rows.length; i++) {
      if (json((hData.rows as Row[])[i]) !== json(rows[i])) c.fail(step, `row ${i} is ${json((hData.rows as Row[])[i])}, expected ${json(rows[i])}`);
    }
    const summary = hData.summary as Obj;
    const wantByPresentation = { console_revision_shown: 2, agent_context_covered: 6, not_recorded: 1, unknown: 2 };
    const wantByBasis = { explicit_recorded: 2, standing_delegation_recorded: 1, unknown: 8 };
    if (json(summary.byPresentation) !== json(wantByPresentation) || json(summary.byDecisionBasis) !== json(wantByBasis)) {
      c.fail(step, `summary ${json(summary)}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test((hData.rows as Row[]).find((r) => r.initiative === sealed.split("/")[0])?.approvedAt ?? "")) c.fail(step, "the sealed one is not dated by day");
    c.pass("History answers A's eleven approvals newest first, each with its version, content revision and time, a day alone for " +
      "the one sealed before the events; shown in the console twice, covered in an agent's context six times (the console " +
      "presentation seconds before an agent's approval and the revision presented again after a newer one among them), one " +
      "context that covered nothing, two unknown; explicit twice, delegation once; the one B signed for A included");

    step = "B reads none of A's approvals";
    const bHistory = ((await read(B, "?tab=history")).body.history as Obj).data as Obj;
    const bNames = (bHistory.rows as Row[]).map((r) => r.initiative).sort();
    const wantB = [forB, bOwn].map((p) => p.split("/")[0]).sort();
    if (bHistory.total !== 2 || json(bNames) !== json(wantB)) c.fail(step, `B's history is ${json(bHistory)}`);
    const bTiles = theirs.body.tiles as Obj;
    if (bTiles.inYourName !== 2 || json(bTiles.noPresentation) !== json({ count: 0, of: 2 })) c.fail(step, `B's tiles ${json(bTiles)}`);
    if ((hData.rows as Row[]).some((r) => wantB.includes(r.initiative))) c.fail(step, "A's history holds one of B's");
    c.pass("B reads two approvals, their own and the one A signed on their behalf, none of A's, in History or the tiles");

    step = "the tiles";
    const tiles = mine.body.tiles as Obj;
    const wantTiles = { waiting: 2, oldestWaitingSince: wantQueue[0].waitingSince, inYourName: 11, noPresentation: { count: 1, of: 9 } };
    if (json(tiles) !== json(wantTiles)) c.fail(step, `tiles ${json(tiles)}, expected ${json(wantTiles)}`);
    c.pass("the tiles count 2 waiting, the oldest wait, 11 approvals in A's name and 1 of the 9 since review contexts with no presentation recorded");

    step = "approvals by week";
    const weeks = mine.body.weeks as { window: { from: string; to: string; complete: boolean }; figure: { value: number } }[];
    const counts = weeks.map((w) => w.figure.value);
    const placed = weeks.map((w) => want.filter((a) => a.atMs >= Date.parse(w.window.from) && a.atMs < Date.parse(w.window.to)).length);
    if (json(counts) !== json(placed) || counts.reduce((s, n) => s + n, 0) !== 11 || counts.at(-1) !== 8 || counts.at(-2) !== 1 || counts.at(-3) !== 1) {
      c.fail(step, `weeks count ${json(counts)}, where the approvals fall ${json(placed)}`);
    }
    if (weeks.at(-1)!.window.complete || !weeks.at(-2)!.window.complete) c.fail(step, "the running week is complete, or the last whole one is not");
    const monday = want.find((a) => `${a.initiative}/${a.path}` === apart)!;
    const holding = weeks.find((w) => monday.atMs >= Date.parse(w.window.from) && monday.atMs < Date.parse(w.window.to));
    if (new Date(monday.atMs).getUTCDay() !== 0 || holding?.window.from !== iso(early - 6 * HOUR)) {
      c.fail(step, `the approval at 06:00 on a Monday in ${TIMEZONE} (${iso(monday.atMs)}) is in the week from ${holding?.window.from}, ` +
        `where that Monday's week begins ${iso(early - 6 * HOUR)}`);
    }
    c.pass(`approvals by week count each one once: ${json(counts)}, the running week not complete, and the one at 06:00 on a ` +
      `Monday in ${TIMEZONE}, still Sunday in UTC, in that Monday's week`);

    step = "the exported reads";
    const span = { from: weeks[0].window.from, to: asOf };
    const byMonth = await gw.callerApprovals(c.team, A, span, asOf, "month");
    const monthSum = byMonth.periods.reduce((s, p) => s + ((p.figure as Obj).value as number), 0);
    if (byMonth.total !== 11 || monthSum !== 11 || byMonth.periods.some((p) => !/^\d{4}-\d{2}-\d{2}T16:00:00Z$/.test((p.window as Obj).from as string))) {
      c.fail(step, `callerApprovals by month answered ${json(byMonth)}`);
    }
    const lastWeek = await gw.callerApprovalRows(c.team, A, { from: weeks.at(-2)!.window.from, to: weeks.at(-2)!.window.to }, asOf);
    if (json(lastWeek) !== json(rows.filter((r) => r.initiative === delegated.split("/")[0]))) c.fail(step, `callerApprovalRows ${json(lastWeek)}`);
    if ((await gw.callerApprovalRows(c.team, B, span, asOf)).length !== 2) c.fail(step, "callerApprovalRows of B is not B's two");
    c.pass("callerApprovals counts the same eleven by month on local month starts, and callerApprovalRows answers last week's one, and B's two");

    step = "tab pages its own list";
    const h = (await read(A, "?tab=history&limit=3&offset=2")).body;
    if (json(((h.history as Obj).data as Obj).rows) !== json(rows.slice(2, 5)) || json(((h.waiting as Obj).data as Obj).rows) !== json(wantQueue)) {
      c.fail(step, `tab=history&limit=3&offset=2 answered ${json(h)}`);
    }
    const w = (await read(A, "?tab=waiting&limit=1&offset=1")).body;
    const wHistory = (w.history as Obj).data as Obj;
    if (json(((w.waiting as Obj).data as Obj).rows) !== json(wantQueue.slice(1)) || json(wHistory.rows) !== json(rows.slice(0, 10)) || wHistory.total !== 11) {
      c.fail(step, `tab=waiting&limit=1&offset=1 answered ${json(w)}`);
    }
    if (json(((mine.body.history as Obj).data as Obj).rows) !== json(rows.slice(0, 10))) c.fail(step, "the default read's history is not its first ten");
    for (const q of ["?tab=other", "?limit=101", "?offset=-1", "?tab=waiting&tab=history"]) {
      const r = await read(A, q);
      if (r.status !== 400 || typeof r.body.error !== "string") c.fail(step, `${q} answered ${r.status}`);
    }
    if ((((await read(A, "?scope=platform")).body.history as Obj).data as Obj).total !== 11) c.fail(step, "?scope=platform changed the answer");
    c.pass("tab pages its own list while the other answers its first ten and its total; a bad tab or page is 400; ?scope=platform widens nothing");

    step = "a list that cannot be read leaves its tiles null";
    await c.sql.query("alter table zz.event rename to event_hidden");
    const broken = await read(A).finally(() => c.sql.query("alter table zz.event_hidden rename to event"));
    {
      const t = broken.body.tiles as Obj;
      const qOk = (broken.body.waiting as Obj).state === "ok", hOk = (broken.body.history as Obj).state === "ok";
      if (broken.status !== 200) c.fail(step, `answered ${broken.status}: ${json(broken.body)}`);
      if (qOk && hOk) c.fail(step, "with zz.event gone both lists still read; the step tests nothing");
      if (!qOk && t.waiting !== null) c.fail(step, `the queue is unavailable and its tile reads ${json(t.waiting)}`);
      if (!hOk && (t.inYourName !== null || t.noPresentation !== null)) c.fail(step, `the history is unavailable and its tiles read ${json(t)}`);
      if (qOk && typeof t.waiting !== "number") c.fail(step, `the queue read and its tile is ${json(t.waiting)}`);
      if (hOk && typeof t.inYourName !== "number") c.fail(step, `the history read and its tile is ${json(t.inYourName)}`);
    }
    c.pass("a list that cannot be read leaves its own tiles null, never zero, and the other list's stand");

    step = "the shapes the console's fake answers";
    let fake: { approvals: (who: Obj, q: URLSearchParams) => [number, unknown] };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const ava = { email: "ava.lindqvist@example.com", activeTeam: "atlas" };
    const diffs = [
      ...shapeDiffs(mine.body, fake.approvals(ava, new URLSearchParams())[1], "waiting", []),
      ...shapeDiffs((await read(A, "?tab=history")).body, fake.approvals(ava, new URLSearchParams("tab=history"))[1], "history", []),
    ];
    if (diffs.length) c.fail(step, diffs.join("; "));
    c.pass("both tabs agree in shape with the fake's, key set by key set");
  } finally {
    server.close();
    await dbModule.platformDb().end();
    for (const k of ["TEAM_DB_URL", "CORE_MCP_URL", "ZZ_TZ"]) delete process.env[k];
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
