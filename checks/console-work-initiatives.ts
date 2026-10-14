#!/usr/bin/env node
/**
 * checks/console-work-initiatives.ts — Initiatives is read for the active team, paged and filtered on
 * the server, with zz-core's next move, and Work's shared closure and search figures answer over the
 * same record (AC-5.5).
 *
 *   node checks/console-work-initiatives.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), makes the
 * initiatives `scripts/schema/work-seed.ts` declares through zz-core's own tools, moves each one's
 * timestamps into the weeks the seed names, writes the seed's searches, and calls the gateway's own
 * built list route (`services/gateway/dist/console/initiatives.js`, which mounts initiative-list.js)
 * the way Express would, signed in as a console session, its relay reaching that zz-core. What it
 * establishes, with the expected values written in the seed:
 *
 *   - the tiles (open, waiting, closed by each outcome), the closures by week and outcome, and per row
 *     the initiative, its flow, its state, the gates passed of its flow's gated documents and when it
 *     was last touched, in the list's order: waiting first, then the most recently touched;
 *   - every row's next move is what initiative_status answers for it alone, for a page of more than
 *     ten rows too, which is relayed in two batches;
 *   - state, flow and q filter before paging, with the total and the summary of what matched, which a
 *     filter changes and a page does not; the tiles are the team's whatever the filters;
 *   - no row names a team; reading the list records no event; presenting a quiet initiative's
 *     document leaves it quiet and its last touch where it was;
 *   - a member and the superadmin each read only their active team, and neither scope=platform nor
 *     another team's slug widens it; a filter or a page the route does not take is a 400;
 *   - a batch zz-core does not answer leaves its rows' next move null and the answer partial, and
 *     none answered leaves it unavailable;
 *   - the key sets match the console's fake answer;
 *   - the shared figures over the seed: the grain a window is drawn at, closures by week and by month,
 *     the median hours to close and to abandon, each recomputed at its own grain, the most open at
 *     once and when, the initiatives opened, and the searches that found something.
 *
 * It prints how long zz-core took to answer a page of ten names: the throwaway's record is small, so
 * the number is a floor, not the representative measure the plan asks for before anything is cached.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, so a week cut on
 * UTC's calendar moves every instant the seed places before 08:00 on a Monday.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Mcp } from "@zz/mcp-client";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import {
  EXPECTED, MADE, ORDER, OTHER_EMAIL, OTHER_TEAM, TIMEZONE, WEEK, at, place, runningWeek, seedSearches, touchedOf,
  type When,
} from "../scripts/schema/work-seed.ts";

const NAME = "console-work-initiatives";
const DONE = "console-work-initiatives: the active team's initiatives are filtered and paged on the server with " +
  "zz-core's next move, read for nobody else and recorded as nothing, and Work's closure and search figures " +
  "answer over the same record: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-initiatives.ts");

const EXPLORE = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";
/** A spec the spec gate approves: every declared section, one phase, one core statement. */
const SPEC =
  "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n" +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n" +
  "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";

type Obj = Record<string, unknown>;
type Answer = { status: number; body: Obj };
type Route = (req: unknown, res: unknown) => void;
type Who = { email: string; role: "superadmin" | "member"; team: string };
type Move = { action: string; stage: string | null; document: string | null; waitingOn: string | null; why: string } | null;
type Row = { slug: string; flow: string | null; nextMove: Move; state: string; gates: { passed: number; of: number };
             lastTouched: string; opened: string; closed: string | null };
type Figure = { value: number | null; why: string | null };
type Window = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type Period = { window: Window; figure: Figure; numerator: number | null; denominator: number | null };
type Relay = Pick<Mcp, "call">;
type Params = { state: string | null; flow: string | null; q: string; limit: number; offset: number };
interface Built {
  route: Route;
  initiativeList: (team: string, params: Params, asOf: string, relay: Relay) => Promise<Obj>;
  grainFor: (w: { from: string; to: string }) => string;
  closuresByWeek: (team: string, w: { from: string; to: string }, asOf: string, grain: string) => Promise<Obj[]>;
  medianHoursToClose: (team: string, w: { from: string; to: string }, asOf: string, grain: string) => Promise<{ periods: Period[]; overall: Period }>;
  medianHoursToAbandon: (team: string, w: { from: string; to: string }, asOf: string, grain: string) => Promise<{ periods: Period[]; overall: Period }>;
  mostOpenAtOnce: (team: string, w: { from: string; to: string }, asOf: string) => Promise<{ value: Figure; at: string | null }>;
  openedRows: (team: string, w: { from: string; to: string }, asOf: string) => Promise<{ slug: string; flow: string | null; opened: string }[]>;
  searchesWithResults: (team: string, w: { from: string; to: string }, asOf: string, grain: string) => Promise<Period[]>;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
/** Its value with every object's keys in order: an answer's key order is no part of its contract. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Obj)[k])])) : v;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** A list answer's summary with its own cutoff named as such: two reads a second apart observe the running week
 *  through different instants, and nothing else of the summary may differ. */
const summaryOf = (l: Obj): string => JSON.stringify(l.summary).replaceAll(String((l.meta as Obj).asOf), "<asOf>");
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold, the first elements,
 *  the same way; a null on either side, nothing. */
function shapeDiffs(a: unknown, b: unknown, path: string, out: string[]): string[] {
  if (a === null || b === null) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${path}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

/** The request a console session's read arrives as, past the gateway's middleware: its resolved identity, and the
 *  `x-zz-*` headers it stamps, which the route's relay forwards to zz-core (COUPLED: identity.ts). */
function request(who: Who, query: Record<string, string | string[]>): Obj {
  return {
    params: {}, query,
    zzIdentity: { email: who.email, displayName: "Work", platformRole: who.role, via: "session",
                  teams: [{ slug: who.team, role: "admin" }], activeTeam: who.team, patTeam: null, sessionTeam: who.team },
    headers: {
      "x-zz-user-email": who.email, "x-zz-user-name": "Work", "x-zz-user-id": "",
      "x-zz-user-role": who.role === "superadmin" ? "admin" : "user", "x-zz-via": "session",
      "x-zz-pat-team": "", "x-zz-session-team": who.team,
    },
  };
}

/** Calls the mounted route as Express would, and waits for the answer it sends. */
function answer(route: Route, req: Obj): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Obj) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

/** Each initiative of the seed made through zz-core as the seeded person, then moved where the seed says: its
 *  dated name by its key. */
async function make(c: Core, w0: number): Promise<Map<string, string>> {
  const slugs = new Map<string, string>();
  for (const m of MADE) {
    const step = `make ${m.key}`;
    const slug = await c.open(m.key, m.flow ?? undefined);
    slugs.set(m.key, slug);
    if (m.docs === "notes") await c.ok(step, "document_write", { path: `${slug}/notes.md`, content: "# Notes\n\nwritten\n" });
    if (m.docs !== "none" && m.docs !== "notes") await c.ok(step, "document_write", { path: `${slug}/explore.md`, content: EXPLORE });
    if (m.docs === "spec-presented" || m.docs === "spec-signed") {
      await c.ok(step, "document_write", { path: `${slug}/spec.md`, content: SPEC });
      if (m.docs === "spec-presented") await c.ok(step, "document_present", { path: `${slug}/spec.md` });
      else await c.sign(`${slug}/spec.md`);
    }
    if (m.close === "abandoned") await c.ok(step, "initiative_close", { initiative: slug, disposition: "abandoned" });
    if (m.close === "accepted") await c.ok(step, "initiative_close", { initiative: slug, disposition: "finished", document: "notes.md" });
    if (m.close === "delivered") {
      await c.ok(step, "initiative_close", { initiative: slug, disposition: "finished", document: "notes.md",
                                             no_signoff_reason: "the person who asked for it moved on before signing off" });
    }
    await place(c.sql, slug, m, w0);
  }
  return slugs;
}

/** initiative_status's next move for one initiative alone, with the console's keys: none, with zz-core's sentence,
 *  where zz-core names none. */
async function statusMove(c: Core, slug: string): Promise<Move> {
  const s = JSON.parse(await c.ok(`initiative_status ${slug}`, "initiative_status", { initiative: slug })) as
    { next_move?: { action: string; stage?: string; document?: string; waiting_on?: string; why: string } | null; next_move_absent?: string };
  const m = s.next_move;
  return m ? { action: m.action, stage: m.stage ?? null, document: m.document ?? null, waitingOn: m.waiting_on ?? null, why: m.why }
    : { action: "none", stage: null, document: null, waitingOn: null, why: s.next_move_absent ?? "no next move is declared" };
}

async function load(c: Core): Promise<{ built: Built; end: () => Promise<void> }> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  const dist = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const db = (await dist("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { mountInitiatives } = (await dist("console/initiatives.js")) as { mountInitiatives: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountInitiatives({ get: (path: string, h: Route) => routes.set(path, h) });
  const route = routes.get("/api/console/initiatives") ?? c.fail("mount", "no route GET /api/console/initiatives");
  const list = (await dist("console/initiative-list.js")) as Pick<Built, "initiativeList">;
  const figures = (await dist("console/work-figures.js")) as Omit<Built, "route" | "initiativeList">;
  return { built: { route, ...list, ...figures }, end: () => db.platformDb().end() };
}

async function run(c: Core): Promise<void> {
  const member = await c.member();
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name, role) values ($1, 'Other', 'member') returning id),
          t as (insert into zz.team (slug, name, created_by) select $2, 'Other team', id from p returning id),
          m as (insert into zz.membership (team_id, principal_id, role, added_by) select t.id, p.id, 'admin', p.id from t, p)
     update zz.principal set active_team_id = (select id from t) where id = (select id from p)`, [OTHER_EMAIL, OTHER_TEAM]);
  const theirs = await c.ok("make the other team's", "initiative_open", { slug: "other-work" }, c.client({ email: OTHER_EMAIL }));
  const theirSlug = (JSON.parse(theirs) as { initiative: string }).initiative;
  const w0 = runningWeek(Date.now());
  const slugs = await make(c, w0);
  await seedSearches(c.sql, c.team, OTHER_TEAM, w0);
  const slug = (key: string): string => slugs.get(key) ?? c.fail("seed", `no initiative ${key}`);
  const when = (w: When): string => iso(at(w0, w));
  const madeOf = (key: string) => MADE.find((m) => m.key === key)!;

  const { built, end } = await load(c);
  const SUPER: Who = { email: c.email, role: "superadmin", team: c.team };
  const MEMBER: Who = { email: member, role: "member", team: c.team };
  const read = (who: Who, query: Record<string, string | string[]> = {}) => answer(built.route, request(who, query));
  const listed = async (step: string, who: Who, query: Record<string, string | string[]> = {}): Promise<Obj> => {
    const a = await read(who, query);
    if (a.status !== 200) c.fail(step, `?${new URLSearchParams(query as Record<string, string>)} answered ${a.status}: ${show(a.body)}`);
    return a.body;
  };
  const rowsOf = (l: Obj): Row[] => l.rows as Row[];
  const okPart = (step: string, part: unknown): Obj => {
    if (!isObj(part) || part.state !== "ok") c.fail(step, `a part was ${show(part)}`);
    return part.data as Obj;
  };
  const weekWindow = (back: number, asOf: string): Window => {
    const from = w0 - back * WEEK, to = from + WEEK;
    return { from: iso(from), to: iso(to), observedFrom: iso(from), observedThrough: back === 0 ? asOf : iso(to), complete: back > 0 };
  };

  try {
    let step = "the tiles, the closures by week and outcome, and the first page in the list's order";
    const first = await listed(step, SUPER);
    const asOf = String((first.meta as Obj).asOf);
    if (!same(first.tiles, EXPECTED.tiles)) c.fail(step, `tiles ${show(first.tiles)}`);
    const closures = okPart(step, first.closures) as unknown as Obj[];
    const wantClosures = Array.from({ length: EXPECTED.weeks }, (_, i) => {
      const back = EXPECTED.weeks - 1 - i;
      const [a, d, ab] = EXPECTED.closures[back] ?? [0, 0, 0];
      const n = (v: number) => ({ value: v, why: null });
      return { window: weekWindow(back, asOf), accepted: n(a), delivered: n(d), abandoned: n(ab) };
    });
    if (!same(closures, wantClosures)) c.fail(step, `closures ${show(closures)}`);
    if (first.total !== 13 || (first.meta as Obj).scope !== "active-team" || first.nextMoveState !== "ok") {
      c.fail(step, `total ${String(first.total)}, scope ${show((first.meta as Obj).scope)}, nextMoveState ${String(first.nextMoveState)}`);
    }
    const page = rowsOf(first);
    if (!same(page.map((r) => r.slug), ORDER.slice(0, 10).map(slug))) c.fail(step, `rows ${show(page.map((r) => r.slug))}`);
    for (const r of page) {
      const m = MADE.find((x) => slug(x.key) === r.slug)!;
      const want = { flow: m.flow, state: m.state, gates: { passed: m.gates[0], of: m.gates[1] }, lastTouched: when(touchedOf(m)),
                     closed: m.closed ? when(m.closed) : null };
      const got = { flow: r.flow, state: r.state, gates: r.gates, lastTouched: r.lastTouched, closed: r.closed };
      if (!same(got, want)) c.fail(step, `${m.key} read ${show(got)}, not ${show(want)}`);
      if (m.opened && r.opened !== when(m.opened)) c.fail(step, `${m.key} opened ${r.opened}, not ${when(m.opened)}`);
    }
    c.pass(step);

    step = "the summary is of the whole population, and a page changes the rows and nothing else";
    const summary = okPart(step, first.summary);
    const touched = (summary.touched as Period[]).map((p) => p.figure.value);
    const wantTouched = Array.from({ length: EXPECTED.weeks }, (_, i) => EXPECTED.touched[EXPECTED.weeks - 1 - i] ?? 0);
    const previous = summary.previous as { window: Window; total: number };
    if (summary.total !== 13 || !same(summary.byState, EXPECTED.byState) || !same(summary.byFlow, EXPECTED.byFlow)
        || !same(touched, wantTouched) || !same(previous, { window: weekWindow(1, asOf), total: 13 })) {
      c.fail(step, `summary ${show(summary)}`);
    }
    const second = await listed(step, SUPER, { offset: "10" });
    if (!same(rowsOf(second).map((r) => r.slug), ORDER.slice(10).map(slug)) || summaryOf(second) !== summaryOf(first)
        || second.total !== 13 || !same(second.tiles, first.tiles)) {
      c.fail(step, `offset 10 read ${show(rowsOf(second).map((r) => r.slug))}, its summary ${show(second.summary)}`);
    }
    const middle = await listed(step, SUPER, { limit: "5", offset: "5" });
    if (!same(rowsOf(middle).map((r) => r.slug), ORDER.slice(5, 10).map(slug)) || summaryOf(middle) !== summaryOf(first)) {
      c.fail(step, `limit 5 offset 5 read ${show(rowsOf(middle).map((r) => r.slug))}`);
    }
    c.pass(step);

    step = "state, flow and q filter before paging, the total and summary are what matched, and the tiles stand";
    const filters: [Record<string, string>, string[]][] = [
      [{ state: "quiet" }, ["q-quiet", "q-empty"]],
      [{ state: "waiting" }, ["w-spec"]],
      [{ flow: "sdlc-flow" }, ["w-spec", "g-plan", "q-quiet", "ab-doc"]],
      [{ q: "SEARCH " }, ["search-ranking", "search-cache"]],
      [{ state: "delivered", q: "search" }, ["search-cache"]],
      [{ flow: "no-such-flow" }, []],
      [{ state: "abandoned", limit: "1" }, ["ab-empty"]],
    ];
    for (const [query, keys] of filters) {
      const l = await listed(step, MEMBER, query);
      const s = okPart(step, l.summary);
      const total = query.limit ? 2 : keys.length;
      const byState = s.byState as Record<string, number>;
      if (!same(rowsOf(l).map((r) => r.slug), keys.map(slug)) || l.total !== total || s.total !== total
          || !same(l.tiles, EXPECTED.tiles) || (s.touched as Period[]).reduce((n, p) => n + Number(p.figure.value), 0) !== total
          || Object.values(byState).reduce((n, v) => n + v, 0) !== total) {
        c.fail(step, `?${new URLSearchParams(query)} read ${show(rowsOf(l).map((r) => r.slug))}, total ${String(l.total)}, ` +
          `summary ${show(s)}`);
      }
      if (query.state && byState[query.state] !== total) c.fail(step, `?${new URLSearchParams(query)} counted ${show(byState)}`);
    }
    c.pass(step);

    step = "no row names a team, and nothing of another team is read";
    // The meta's population says whose initiatives these are; a row never does.
    const text = JSON.stringify([page, rowsOf(second)]);
    if (page.some((r) => "team" in r) || text.includes(c.team) || text.includes(OTHER_TEAM)
        || JSON.stringify([first, second]).includes(theirSlug) || JSON.stringify([first, second]).includes(OTHER_TEAM)) {
      c.fail(step, "a row names a team, or the other team's work is in the answer");
    }
    c.pass(step);

    step = "reading the list records no event";
    const events = async (): Promise<number> =>
      (await c.sql.query<{ n: number }>("select count(*)::int as n from zz.event")).rows[0].n;
    const before = await events();
    const all = await listed(step, MEMBER, { limit: "13" });
    await new Promise((r) => setTimeout(r, 1500));
    if (await events() !== before) c.fail(step, `${(await events()) - before} events were recorded by reading the list`);
    c.pass(step);

    step = "every row's next move, a page of thirteen in two batches, is what initiative_status answers for it alone";
    if (all.nextMoveState !== "ok" || rowsOf(all).length !== 13) c.fail(step, `nextMoveState ${String(all.nextMoveState)}`);
    for (const r of rowsOf(all)) {
      const want = await statusMove(c, r.slug);
      if (!same(r.nextMove, want)) c.fail(step, `${r.slug} reads ${show(r.nextMove)}, where initiative_status answers ${show(want)}`);
    }
    const moveOf = (key: string): Move => rowsOf(all).find((r) => r.slug === slug(key))!.nextMove;
    if (moveOf("w-spec")?.action !== "await_approval" || moveOf("w-spec")?.document !== "spec.md"
        || MADE.filter((m) => m.close).some((m) => moveOf(m.key)?.action !== "closed")
        || ["o-fresh", "o-empty", "q-empty", "search-ranking"].some((k) => moveOf(k)?.action !== "none" || !moveOf(k)?.why)
        || moveOf("q-quiet") === null) {
      c.fail(step, `the next moves were ${show(rowsOf(all).map((r) => [r.slug, r.nextMove?.action, r.nextMove?.document]))}`);
    }
    c.pass(step);

    step = "presenting a quiet initiative's document leaves it quiet, its last touch where it was";
    const quiet = slug("q-quiet");
    await c.ok(step, "document_present", { path: `${quiet}/explore.md` }, c.client({ via: "session" }));
    const { rows: [shown] } = await c.sql.query<{ presented: boolean }>(
      `select r.presented_at is not null as presented from zz.doc d join zz.initiative i on i.id = d.initiative_id
         join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
        where i.slug = $1 and d.path = 'explore.md'`, [quiet]);
    const after = rowsOf(await listed(step, MEMBER, { state: "quiet" })).find((r) => r.slug === quiet);
    if (!shown?.presented || after?.state !== "quiet" || after.lastTouched !== when(touchedOf(madeOf("q-quiet")))) {
      c.fail(step, `presented ${String(shown?.presented)}; the row reads ${show(after)}`);
    }
    c.pass(step);

    step = "each person reads their active team, and neither a scope nor another team's slug widens it";
    const plain = await listed(step, SUPER, { limit: "100" });
    const key = (l: Obj) => JSON.stringify({ rows: rowsOf(l).map((r) => r.slug), tiles: l.tiles, total: l.total });
    for (const [who, query] of [[SUPER, { scope: "platform" }], [SUPER, { team: OTHER_TEAM }], [SUPER, { scope: "platform", team: OTHER_TEAM }],
                                [MEMBER, {}], [MEMBER, { team: OTHER_TEAM }], [MEMBER, { scope: "platform" }]] as [Who, Record<string, string>][]) {
      const l = await listed(step, who, { limit: "100", ...query });
      if (key(l) !== key(plain)) c.fail(step, `${who.role} with ?${new URLSearchParams(query)} read ${key(l)}`);
    }
    const elsewhere = await listed(step, { ...SUPER, team: OTHER_TEAM }, { limit: "100" });
    if (!same(rowsOf(elsewhere).map((r) => r.slug), [theirSlug]) || elsewhere.total !== 1) {
      c.fail(step, `the superadmin acting for ${OTHER_TEAM} read ${show(rowsOf(elsewhere).map((r) => r.slug))}`);
    }
    c.pass(step);

    step = "a filter or a page the route does not take is refused";
    for (const query of [{ state: "stalled" }, { limit: "0" }, { limit: "101" }, { limit: "ten" }, { offset: "-1" },
                         { offset: "1.5" }, { state: ["open", "quiet"] }, { q: ["a", "b"] }] as Record<string, string | string[]>[]) {
      const a = await read(MEMBER, query);
      if (a.status !== 400 || typeof a.body.error !== "string") c.fail(step, `${show(query)} answered ${a.status}: ${show(a.body)}`);
    }
    c.pass(step);

    step = "a batch zz-core does not answer leaves its rows' next move null, and none answered leaves them all";
    const session = c.client({ via: "session" });
    const failing = (fails: (names: string[]) => boolean): Relay => ({
      call: async (tool: string, args: unknown) => {
        if (fails((args as { initiatives: string[] }).initiatives)) throw new Error("zz-core did not answer");
        return session.call(tool, args);
      },
    });
    const everything = { state: null, flow: null, q: "", limit: 13, offset: 0 };
    const partial = await built.initiativeList(c.team, everything, asOf, failing((names) => names.length < 10));
    const nulls = rowsOf(partial).map((r) => r.nextMove === null);
    if (partial.nextMoveState !== "partial" || !same(nulls, [...Array(10).fill(false), true, true, true])) {
      c.fail(step, `a failed second batch read ${String(partial.nextMoveState)} with nulls ${show(nulls)}`);
    }
    const none = await built.initiativeList(c.team, everything, asOf, failing(() => true));
    if (none.nextMoveState !== "unavailable" || rowsOf(none).some((r) => r.nextMove !== null) || !same(none.tiles, EXPECTED.tiles)) {
      c.fail(step, `no batch answered and the list read ${String(none.nextMoveState)}`);
    }
    const errored = await built.initiativeList(c.team, everything, asOf, { call: async () => "ERROR: refused" });
    if (errored.nextMoveState !== "unavailable") c.fail(step, `zz-core's refusal read ${String(errored.nextMoveState)}`);
    c.pass(step);

    step = "the key sets match the console's fake answer";
    let fake: { initiativeList: (who: unknown, q: URLSearchParams) => [number, unknown] };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const [fakeStatus, fakeBody] = fake.initiativeList({ activeTeam: "atlas" }, new URLSearchParams());
    const diffs = shapeDiffs(first, fakeBody, "", []);
    if (fakeStatus !== 200 || diffs.length) c.fail(step, diffs.join("; ") || `the fake answered ${fakeStatus}`);
    c.pass(step);

    await figures(c, built, w0, asOf, slug);

    step = "how long zz-core takes to answer a page of ten names";
    const names = ORDER.slice(0, 10).map(slug);
    const took: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await session.call("initiative_status", { initiatives: names });
      took.push(performance.now() - t0);
    }
    c.pass(`${step}: ${took.map((t) => `${Math.round(t)} ms`).join(", ")} on the throwaway's thirteen initiatives`);
  } finally {
    await end();
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
    delete process.env.ZZ_CATALOG_DIR;
  }
}

/** Work's shared figures over the seed, each against the values the seed writes. */
async function figures(c: Core, f: Built, w0: number, asOf: string, slug: (key: string) => string): Promise<void> {
  const team = c.team;
  const when = (w: When): string => iso(at(w0, w));
  const record = { from: iso(w0 - 6 * WEEK), to: asOf };
  const period = (back: number, value: number | null, numerator: number | null, denominator: number | null) => ({
    window: { from: iso(w0 - back * WEEK), to: iso(w0 - (back - 1) * WEEK), observedFrom: iso(w0 - back * WEEK),
              observedThrough: back === 0 ? asOf : iso(w0 - (back - 1) * WEEK), complete: back > 0 },
    figure: value === null ? { value: null, why: "no_data" } : { value, why: null }, numerator, denominator,
  });
  const backs = Array.from({ length: EXPECTED.weeks }, (_, i) => EXPECTED.weeks - 1 - i);

  let step = "the grain: weeks up to 26, months up to three years, quarters beyond";
  const from = "2026-01-05T00:00:00Z";
  const plus = (ms: number) => new Date(Date.parse(from) + ms).toISOString();
  const grains = [f.grainFor({ from, to: plus(26 * WEEK) }), f.grainFor({ from, to: plus(26 * WEEK + 1000) }),
                  f.grainFor({ from, to: "2029-01-05T00:00:00Z" }), f.grainFor({ from, to: "2029-01-06T00:00:00Z" })];
  if (!same(grains, ["week", "month", "month", "quarter"])) c.fail(step, show(grains));
  c.pass(step);

  step = "closures by week and outcome, and by month, each period counting its own";
  if (f.grainFor(record) !== "week") c.fail(step, `the record's grain is ${f.grainFor(record)}`);
  const weekly = await f.closuresByWeek(team, record, asOf, "week");
  const counts = weekly.map((w) => ["accepted", "delivered", "abandoned"].map((o) => (w[o] as Figure).value));
  if (!same(counts, backs.map((b) => EXPECTED.closures[b] ?? [0, 0, 0]))
      || !same(weekly.map((w) => w.window), backs.map((b) => period(b, 0, 0, 0).window))) {
    c.fail(step, `by week ${show(weekly)}`);
  }
  // By month: each closure in the local month it fell in, the months from the record's first.
  const local = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 7);
  const months = await f.closuresByWeek(team, record, asOf, "month");
  const wantMonths = new Map<string, number>();
  for (const m of MADE.filter((x) => x.closed)) wantMonths.set(local(at(w0, m.closed!)), (wantMonths.get(local(at(w0, m.closed!))) ?? 0) + 1);
  const gotMonths = new Map(months.map((m) => [local(Date.parse(String((m.window as Window).from))),
    ["accepted", "delivered", "abandoned"].reduce((n, o) => n + Number((m[o] as Figure).value), 0)]));
  if ((months[0] && local(Date.parse((months[0].window as Window).from)) !== local(Date.parse(record.from)))
      || [...wantMonths].some(([k, n]) => gotMonths.get(k) !== n) || [...gotMonths.values()].reduce((a, b) => a + b, 0) !== 6) {
    c.fail(step, `by month ${show(months)}`);
  }
  c.pass(step);

  step = "the median hours to close and to abandon, by week and over the record";
  const toClose = await f.medianHoursToClose(team, record, asOf, "week");
  const wantClose = backs.map((b) => (EXPECTED.toClose[b] ? period(b, EXPECTED.toClose[b][0], null, EXPECTED.toClose[b][1]) : period(b, null, null, 0)));
  // The record as one period: it ends at the cutoff, so it is observed whole.
  const overallWindow = { from: record.from, to: asOf, observedFrom: record.from, observedThrough: asOf, complete: true };
  if (!same(toClose.periods, wantClose)
      || !same(toClose.overall, { window: overallWindow, figure: { value: EXPECTED.toCloseOverall[0], why: null }, numerator: null, denominator: EXPECTED.toCloseOverall[1] })) {
    c.fail(step, `to close ${show(toClose)}`);
  }
  const toAbandon = await f.medianHoursToAbandon(team, record, asOf, "week");
  const wantAbandon = backs.map((b) => (EXPECTED.toAbandon[b] ? period(b, EXPECTED.toAbandon[b][0], null, EXPECTED.toAbandon[b][1]) : period(b, null, null, 0)));
  if (!same(toAbandon.periods, wantAbandon) || toAbandon.overall.figure.value !== EXPECTED.toAbandonOverall[0]
      || toAbandon.overall.denominator !== EXPECTED.toAbandonOverall[1]) {
    c.fail(step, `to abandon ${show(toAbandon)}`);
  }
  // By month, each month's median is its own closures', never an average of its weeks'.
  const hours = (m: (typeof MADE)[number]) => (at(w0, m.closed!) - at(w0, m.opened!)) / 3_600_000;
  const monthly = await f.medianHoursToClose(team, record, asOf, "month");
  for (const p of monthly.periods) {
    const mine = MADE.filter((m) => m.closed && local(at(w0, m.closed)) === local(Date.parse(p.window.from))).map(hours).sort((a, b) => a - b);
    const mid = mine.length >> 1;
    const want = mine.length === 0 ? null : mine.length % 2 ? mine[mid] : (mine[mid - 1] + mine[mid]) / 2;
    if (p.figure.value !== want || p.denominator !== mine.length) c.fail(step, `the month from ${p.window.from} read ${show(p)}, not ${String(want)} over ${mine.length}`);
  }
  c.pass(step);

  step = "the most open at once, and when it was first reached";
  const most = await f.mostOpenAtOnce(team, record, asOf);
  const third = await f.mostOpenAtOnce(team, { from: iso(w0 - 3 * WEEK), to: iso(w0 - 2 * WEEK) }, asOf);
  if (!same(most, { value: { value: EXPECTED.mostOpen.value, why: null }, at: when(EXPECTED.mostOpen.at) })
      || !same(third, { value: { value: EXPECTED.mostOpenThird.value, why: null }, at: when(EXPECTED.mostOpenThird.at) })) {
    c.fail(step, `over the record ${show(most)}; over the third week back ${show(third)}`);
  }
  c.pass(step);

  step = "the initiatives opened in a window, the earliest first";
  const opened = await f.openedRows(team, { from: iso(w0 - 2 * WEEK), to: iso(w0 - WEEK) }, asOf);
  const wantOpened = EXPECTED.openedSecond.map((k) => ({ slug: slug(k), flow: null, opened: when(MADE.find((m) => m.key === k)!.opened!) }));
  if (!same(opened, wantOpened)) c.fail(step, show(opened));
  c.pass(step);

  step = "searches with results: the team's completed work searches that found something, by week";
  const searches = await f.searchesWithResults(team, record, asOf, "week");
  const wantSearches = backs.map((b) => {
    const s = EXPECTED.searches[b];
    return s ? period(b, (100 * s[0]) / s[1], s[0], s[1]) : period(b, null, 0, 0);
  });
  if (!same(searches, wantSearches)) c.fail(step, show(searches));
  c.pass(step);
}

// Set before the harness starts zz-core, so both sides cut days and weeks on the same calendar.
process.env.ZZ_TZ = TIMEZONE;
process.exitCode = await withThrowawayCore(NAME, DONE, run);
