/**
 * Teams: every team on the platform as the superadmin reads it, each beside its own past, and one team's own page.
 *
 * `GET /teams` answers the tiles over every team (teams, open work, revisions waiting, standing lessons) and one
 * page of the rows, filtered by `?q` (a slug or a name containing it) and `?status`. A row is what Teams draws: the
 * team, its memberships, its open initiatives, its revisions waiting by `pendingRevisions` at the read's cutoff, its
 * standing lessons, its sessions by week, its calls in the last two complete weeks and its latest real-work call. Rows
 * sort by that call, newest first, a team with none last, the slug breaking a tie.
 *
 * `GET /teams/:slug` answers the team, its members, its tiles and its calls by week. Its tiles are its row's, because
 * the page reads every team with the same functions and picks its own. A slug no team has is a 404 with no body.
 *
 * Both are the superadmin's: mounted through `platformPublic`, they refuse anybody else 403 before anything is read,
 * and take no scope. Weeks are Monday to Monday in `ZZ_TZ` with the status read's cutoff and coverage (`readGrid`),
 * at most 26 of them, from the week the record begins in through the running one, which is not complete. Every
 * call figure counts `tool_call` rows with `origin = 'work'` in a team; a session is a distinct non-empty one.
 *
 * A failed read of the calls by week leaves those figures `unavailable` and the rows standing; every other count
 * stands or falls with the rows, and a failed read of them, of the cutoff or of the revisions waiting is the
 * response's.
 *
 * The Platform prepared query (platform-query-measures.ts) counts the teams and answers their rows through
 * `readBases`, `readFigures` and `rowOf`.
 *
 * COUPLED: the console's `Teams`, `TeamRow` and `TeamDetail` in src/lib/fleet-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/platform-teams.ts, which `checks/console-platform-teams.ts` compares these answers with, key
 * set by key set.
 */
import type { Express, Request } from "express";
import type pg from "pg";

import { platformDb } from "../db.js";
import type { Figure, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { pendingRevisions } from "./pending.js";
import { readGrid, type Grid } from "./platform-measures.js";
import { BAD_PAGE, platformPublic, ZZ_TZ } from "./shared.js";

export const STATUSES = ["active", "archived"] as const;
/** How many weeks a team's series reaches back, the running one included. */
const WEEKS = 26;
const POPULATION = "teams, their members, open work, revisions waiting, standing lessons and real-work tool calls";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type Week = { fromMs: number; toMs: number };
/** A team as `zz.team` and its counts hold it, before any figure is read beside it. */
export type Base = {
  id: string; slug: string; name: string; status: string; created: string;
  people: number; openWork: number; lessons: number; lastMs: number | null;
};
type TeamRow = {
  slug: string; name: string; status: string; created: string;
  people: number; openWork: number; waiting: number; lessons: number;
  sessions: PeriodFigure[]; calls: { last: PeriodFigure; previous: PeriodFigure }; lastActive: string | null;
};
type Teams = { meta: ReadMeta; tiles: { teams: number; openWork: number; pending: number; lessons: number }; teams: TeamRow[]; total: number };
type TeamDetail = {
  team: { slug: string; name: string; status: string; created: string };
  members: { email: string; name: string; role: string; joined: string }[];
  meta: ReadMeta;
  tiles: { people: number; openWork: number; waiting: number; lessons: number };
  calls: PeriodFigure[];
};

/** Every team with its counts and its latest real-work call before `asOf`: `people` counts its memberships,
 *  `openWork` every initiative not closed and `lessons` the nodes standing. */
export async function readBases(db: pg.Pool, asOf: string): Promise<Base[]> {
  const { rows } = await db.query<{
    id: string; slug: string; name: string; status: string; created: string; people: number; open_work: number;
    lessons: number; last_ms: number | null;
  }>(
    `with last as (
       select e.team_id, max(e.ts) as ts
         from zz.event e
        where e.kind = 'tool_call' and e.origin = 'work' and e.team_id is not null and e.ts < $2::timestamptz
        group by e.team_id
     )
     select t.id::text as id, t.slug, t.name, t.status, to_char(t.created_at at time zone $1::text, 'YYYY-MM-DD') as created,
            (select count(*) from zz.membership m where m.team_id = t.id)::int as people,
            (select count(*) from zz.initiative i where i.team_id = t.id and i.closed_at is null)::int as open_work,
            (select count(*) from zz.knowledge_node k where k.team_id = t.id and k.lifecycle = 'adopted')::int as lessons,
            (extract(epoch from l.ts) * 1000)::float8 as last_ms
       from zz.team t
       left join last l on l.team_id = t.id`, [ZZ_TZ, asOf]);
  return rows.map((r) => ({
    id: r.id, slug: r.slug, name: r.name, status: r.status, created: r.created,
    people: r.people, openWork: r.open_work, lessons: r.lessons, lastMs: r.last_ms,
  }));
}

/** The `WEEKS` Monday weeks ending in the running one, cut on local wall time as `readGrid` cuts them. */
async function readWeeks(db: pg.Pool, asOf: string): Promise<Week[]> {
  return (await db.query<{ from_ms: number; to_ms: number }>(
    `select (extract(epoch from (w at time zone $1::text)) * 1000)::float8 as from_ms,
            (extract(epoch from ((w + interval '1 week') at time zone $1::text)) * 1000)::float8 as to_ms
       from generate_series(date_trunc('week', $2::timestamptz at time zone $1::text) - ($3::int - 1) * interval '1 week',
                            date_trunc('week', $2::timestamptz at time zone $1::text),
                            interval '1 week') as w
      order by w`, [ZZ_TZ, asOf, WEEKS])).rows.map((r) => ({ fromMs: r.from_ms, toMs: r.to_ms }));
}

/** Each team's real-work calls and distinct non-empty sessions by the instant its week starts, from `fromMs`. */
async function readCalls(db: pg.Pool, fromMs: number, asOf: string): Promise<Map<string, { calls: number; sessions: number }>> {
  const { rows } = await db.query<{ team_id: string; from_ms: number; calls: number; sessions: number }>(
    `select e.team_id::text as team_id,
            (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as calls,
            (count(distinct e.session) filter (where e.session <> ''))::int as sessions
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.team_id is not null
        and e.ts >= $2::timestamptz and e.ts < $3::timestamptz
      group by 1, 2`, [ZZ_TZ, new Date(fromMs).toISOString(), asOf]);
  return new Map(rows.map((r) => [`${r.team_id}/${r.from_ms}`, { calls: r.calls, sessions: r.sessions }]));
}

/** What every row's figures are read from, once per request: the cutoff and coverage, the weeks, the calls by week
 *  (null when they could not be read) and the revisions waiting by team. */
type Figures = {
  grid: Grid; weeks: Week[]; drawn: Week[];
  calls: Map<string, { calls: number; sessions: number }> | null;
  waiting: Map<string, number>; pending: number;
};

export async function readFigures(db: pg.Pool, asOfMs?: number): Promise<Figures> {
  const grid = await readGrid(db, asOfMs);
  const asOf = new Date(grid.asOfMs).toISOString();
  const weeks = await readWeeks(db, asOf);
  const calls = await readCalls(db, weeks[0].fromMs, asOf).catch((err: unknown) => {
    console.error("console the teams: the calls by week could not be read:", err);
    return null;
  });
  const waiting = new Map<string, number>();
  const pending = await pendingRevisions(asOf);
  for (const p of pending) waiting.set(p.teamId, (waiting.get(p.teamId) ?? 0) + 1);
  // Only the weeks from the one the record begins in are drawn, as the status read draws them.
  const drawn = grid.coverageMs === null ? [] : weeks.filter((w) => w.toMs > grid.coverageMs!);
  return { grid, weeks, drawn, calls, waiting, pending: pending.length };
}

/** A week's window, as `platform-measures.ts` bounds one: observed from where the record begins through the cutoff,
 *  and complete once it has ended and lies wholly inside the record. A week before the record was never observed. */
function windowOf(w: Week, { asOfMs, coverageMs }: Grid): Window {
  const observed = coverageMs !== null && w.toMs > coverageMs;
  return {
    from: iso(w.fromMs), to: iso(w.toMs),
    observedFrom: observed ? iso(Math.max(w.fromMs, coverageMs)) : null,
    observedThrough: observed ? iso(Math.min(w.toMs, asOfMs)) : null,
    complete: observed && w.toMs <= asOfMs && w.fromMs >= coverageMs,
  };
}

/** One team's count in one week: a zero is a week read that held none; a week before the record, or one whose calls
 *  could not be read, is unavailable. */
function weekFigure(f: Figures, team: string, w: Week, of: "calls" | "sessions"): PeriodFigure {
  const window = windowOf(w, f.grid);
  if (f.calls === null || window.observedFrom === null) {
    return { window, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null };
  }
  const n = f.calls.get(`${team}/${w.fromMs}`)?.[of] ?? 0;
  const figure: Figure = { value: n, why: null };
  return { window, figure, numerator: n, denominator: null };
}

export function rowOf(b: Base, f: Figures): TeamRow {
  return {
    slug: b.slug, name: b.name, status: b.status, created: b.created,
    people: b.people, openWork: b.openWork, waiting: f.waiting.get(b.id) ?? 0, lessons: b.lessons,
    sessions: f.drawn.map((w) => weekFigure(f, b.id, w, "sessions")),
    calls: { last: weekFigure(f, b.id, f.weeks.at(-2)!, "calls"), previous: weekFigure(f, b.id, f.weeks.at(-3)!, "calls") },
    lastActive: b.lastMs === null ? null : iso(b.lastMs),
  };
}

/** Latest real-work call first, a team with none last, the slug breaking a tie. */
function byActivity(a: Base, b: Base): number {
  if (a.lastMs !== b.lastMs) {
    if (a.lastMs === null) return 1;
    if (b.lastMs === null) return -1;
    return b.lastMs - a.lastMs;
  }
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

function metaOf(f: Figures, population: string): ReadMeta {
  const asOf = iso(f.grid.asOfMs);
  return {
    asOf, timezone: ZZ_TZ, period: { from: f.drawn[0] ? iso(f.drawn[0].fromMs) : asOf, to: asOf },
    scope: "platform-admin", population, coverageFrom: f.grid.coverageMs === null ? null : iso(f.grid.coverageMs),
  };
}

/** One query parameter given at most once: its text, null when absent, false when repeated. */
const one = (v: unknown): string | null | false => (v === undefined ? null : typeof v === "string" ? v : false);

/** The list's filter and page, or the refusal. */
function parse(req: Request): { q: string; status: string | null; limit: number; offset: number } | string {
  const [q, status, limitText, offsetText] = ["q", "status", "limit", "offset"].map((k) => one(req.query[k]));
  if (q === false || status === false || limitText === false || offsetText === false) {
    return "each filter and the page are given at most once";
  }
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) return `status must be one of ${STATUSES.join(", ")}`;
  const limit = Number(limitText ?? 10), offset = Number(offsetText ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return { q: (q ?? "").trim().toLowerCase(), status, limit, offset };
}

export function mountTeams(app: Express): void {
  app.get("/api/console/teams", platformPublic("the teams", async (req, res, caller) => {
    if (!caller.superadmin) {
      res.status(403).json({ error: "not permitted" });
      return;
    }
    const asked = parse(req);
    if (typeof asked === "string") {
      res.status(400).json({ error: asked });
      return;
    }
    const db = platformDb();
    const f = await readFigures(db);
    const bases = (await readBases(db, new Date(f.grid.asOfMs).toISOString())).sort(byActivity);
    const sum = (of: (b: Base) => number): number => bases.reduce((n, b) => n + of(b), 0);
    const matching = bases
      .filter((b) => !asked.q || b.slug.includes(asked.q) || b.name.toLowerCase().includes(asked.q))
      .filter((b) => asked.status === null || b.status === asked.status);
    const answer: Teams = {
      meta: metaOf(f, POPULATION),
      tiles: { teams: bases.length, openWork: sum((b) => b.openWork), pending: f.pending, lessons: sum((b) => b.lessons) },
      teams: matching.slice(asked.offset, asked.offset + asked.limit).map((b) => rowOf(b, f)),
      total: matching.length,
    };
    res.json(answer);
  }));

  app.get("/api/console/teams/:slug", platformPublic("a team", async (req, res, caller) => {
    if (!caller.superadmin) {
      res.status(403).json({ error: "not permitted" });
      return;
    }
    const db = platformDb();
    const f = await readFigures(db);
    const base = (await readBases(db, new Date(f.grid.asOfMs).toISOString())).find((b) => b.slug === req.params.slug);
    if (!base) {
      res.status(404).end();
      return;
    }
    const members = await db.query<{ email: string; name: string; role: string; joined: string }>(
      `select p.email, p.display_name as name, m.role,
              to_char(m.created_at at time zone $2::text, 'YYYY-MM-DD') as joined
         from zz.membership m join zz.principal p on p.id = m.principal_id
        where m.team_id = $1::uuid order by m.role, p.email`, [base.id, ZZ_TZ]);
    const row = rowOf(base, f);
    const answer: TeamDetail = {
      team: { slug: row.slug, name: row.name, status: row.status, created: row.created },
      members: members.rows,
      meta: metaOf(f, `${row.slug}'s members, open work, revisions waiting, standing lessons and real-work tool calls`),
      tiles: { people: row.people, openWork: row.openWork, waiting: row.waiting, lessons: row.lessons },
      calls: f.drawn.map((w) => weekFigure(f, base.id, w, "calls")),
    };
    res.json(answer);
  }));
}
