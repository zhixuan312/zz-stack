/**
 * The statements the platform's Usage counts from, and the follow-up statement Status's refusals put
 * right count from too. Each answers rows; `platform-usage.ts` and `platform-measures.ts` shape them,
 * and the Platform prepared query (platform-query-measures.ts) reads the calls and model calls by day.
 *
 * Every week is the reporting timezone's Monday to Monday, keyed by the instant it starts (`from_ms`),
 * as `readGrid` cuts them. A real-work call is a `tool_call` with `origin = 'work'`; a statement that
 * also counts maintenance (`origin = 'platform'`) says so.
 *
 * Each function throws when its statement fails; the read decides what a failure makes of its answer.
 */
import type pg from "pg";

import type { Grid } from "./platform-measures.js";
import { ZZ_TZ } from "./shared.js";

const asOfOf = (grid: Grid): string => new Date(grid.asOfMs).toISOString();
/** The first instant of the grid's first week, or the cutoff when it has none. */
const fromOf = (grid: Grid): string => new Date(grid.weeks[0]?.fromMs ?? grid.asOfMs).toISOString();

export type FollowupRow = {
  from_ms: number; refusals: number; missing_session: number; within_lookahead: number; eligible: number; matched: number;
  median_ms: number | null; refused_sessions: number; continued_sessions: number;
};

/**
 * Refusals by the week they were made, and how each was followed. A refusal with a session whose
 * next 120 seconds were read before the cutoff is eligible; it is put right by the first real-work
 * call of the same team, session and tool that was not refused, `(t, t + 120s)` after it, in the same
 * initiative when both name one, and `median_ms` is the median time to that call over the refusals
 * put right. A refused session is a team and session with an eligible refusal; it continued when a
 * real-work call of its own came after one of them, before the cutoff. `team` narrows to one team's.
 */
export async function followupWeeks(db: pg.Pool, grid: Grid, team: string | null): Promise<FollowupRow[]> {
  return (await db.query<FollowupRow>(
    `with last_call as (
       select c.team_id, c.session, max(c.ts) as at
         from zz.event c
        where c.kind = 'tool_call' and c.origin = 'work' and c.session <> '' and c.ts < $2::timestamptz
          and ($3::uuid is null or c.team_id = $3::uuid)
        group by 1, 2
     ), r as (
       select e.ts, e.session, e.team_id, l.at as last_call_at,
              case when e.session = '' then null else (
                select min(s.ts) from zz.event s
                 where s.kind = 'tool_call' and s.origin = 'work' and s.refusal_owner is null
                   and s.session = e.session and s.tool_key = e.tool_key and s.team_id is not distinct from e.team_id
                   and s.ts > e.ts and s.ts < e.ts + interval '120 seconds' and s.ts < $2::timestamptz
                   and (e.initiative_id is null or s.initiative_id is null or s.initiative_id = e.initiative_id)) end as put_right_at
         from zz.event e
         left join last_call l on l.session = e.session and l.team_id is not distinct from e.team_id
        where e.kind = 'tool_call' and e.origin = 'work' and e.refusal_owner is not null and e.ts < $2::timestamptz
          and ($3::uuid is null or e.team_id = $3::uuid)
     )
     select (extract(epoch from (date_trunc('week', r.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as refusals,
            (count(*) filter (where r.session = ''))::int as missing_session,
            (count(*) filter (where r.session <> '' and r.ts + interval '120 seconds' > $2::timestamptz))::int as within_lookahead,
            (count(*) filter (where r.session <> '' and r.ts + interval '120 seconds' <= $2::timestamptz))::int as eligible,
            (count(*) filter (where r.ts + interval '120 seconds' <= $2::timestamptz and r.put_right_at is not null))::int as matched,
            round(percentile_cont(0.5) within group (order by (extract(epoch from r.put_right_at - r.ts) * 1000)::float8)
                  filter (where r.ts + interval '120 seconds' <= $2::timestamptz and r.put_right_at is not null))::float8 as median_ms,
            (count(distinct coalesce(r.team_id::text, '') || '/' || r.session)
               filter (where r.session <> '' and r.ts + interval '120 seconds' <= $2::timestamptz))::int as refused_sessions,
            (count(distinct coalesce(r.team_id::text, '') || '/' || r.session)
               filter (where r.session <> '' and r.ts + interval '120 seconds' <= $2::timestamptz and r.last_call_at > r.ts))::int as continued_sessions
       from r
      group by 1`, [ZZ_TZ, asOfOf(grid), team])).rows;
}

/** Real-work calls of one local day, one registered tool, one team and one refusal owner. */
export type CallDay = {
  day: string; week_ms: number; tool: string | null; team_id: string | null; slug: string | null;
  owner: "guardrail" | "ours" | "theirs" | "other" | null; calls: number; last_ms: number;
};

/** Real-work calls in `[from, to)`, `from` null for the whole record, by local day (`day`, and the instant its week
 *  starts), registered tool, team and refusal owner, with the latest call of each. `tool` is null for every tool no
 *  door registers in `zz.plugin_tool`, so no other name leaves; `team_id` and `slug` are null for calls in no team.
 *  The one count of calls every call figure here reduces: by week, by team, by tool and the prepared query's. */
export async function callDays(db: pg.Pool, to: string, from: string | null): Promise<CallDay[]> {
  return (await db.query<CallDay>(
    `with vocabulary as (select distinct pt.door || ':' || pt.name as tool from zz.plugin_tool pt)
     select to_char(e.ts at time zone $1::text, 'YYYY-MM-DD') as day,
            (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as week_ms,
            v.tool, e.team_id::text as team_id, t.slug, e.refusal_owner as owner,
            count(*)::int as calls,
            (extract(epoch from max(e.ts)) * 1000)::float8 as last_ms
       from zz.event e
       left join vocabulary v on v.tool = e.tool_key
       left join zz.team t on t.id = e.team_id
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
        and ($3::timestamptz is null or e.ts >= $3::timestamptz)
      group by 1, 2, 3, 4, 5, 6`, [ZZ_TZ, to, from])).rows;
}

/** Every tool a door registers in `zz.plugin_tool`, as `door:name`: the only tool names a call figure says. */
export async function registeredTools(db: pg.Pool): Promise<Set<string>> {
  return new Set((await db.query<{ tool: string }>(
    "select distinct pt.door || ':' || pt.name as tool from zz.plugin_tool pt")).rows.map((r) => r.tool));
}

/** Every model the platform has called. */
export async function modelsCalled(db: pg.Pool): Promise<Set<string>> {
  return new Set((await db.query<{ model: string }>("select distinct m.model from zz.model_call m")).rows.map((r) => r.model));
}

/** Calls summed by `key`, each group's first row standing for the rest of it. */
function summed<R extends { calls: number }>(rows: R[], key: (r: R) => string): R[] {
  const out = new Map<string, R>();
  for (const r of rows) {
    const was = out.get(key(r));
    out.set(key(r), was ? { ...was, calls: was.calls + r.calls } : { ...r });
  }
  return [...out.values()];
}

/** Real-work calls by week and team slug, from the grid's first week; `slug` is null for calls in no team.
 *  DELIBERATE: a statement of its own rather than a reduction of `callDays`, so the superadmin's split fails alone
 *  and every other part of Usage stands; checks/console-platform-query.ts holds the prepared query's calls by team,
 *  read from `callDays`, to it. */
export async function teamWeeks(db: pg.Pool, grid: Grid): Promise<{ from_ms: number; slug: string | null; calls: number }[]> {
  return (await db.query<{ from_ms: number; slug: string | null; calls: number }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            t.slug, count(*)::int as calls
       from zz.event e
       left join zz.team t on t.id = e.team_id
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts >= $3::timestamptz and e.ts < $2::timestamptz
      group by 1, 2`, [ZZ_TZ, asOfOf(grid), fromOf(grid)])).rows;
}

type WeekTraffic = {
  work: number; maintenance: number; guardrail: number; ours: number; theirs: number; other: number; maintenance_refused: number;
};

/** Every tool call in `[fromMs, toMs)`, maintenance included: real work against maintenance, real-work refusals by
 *  owner, and maintenance refusals. */
export async function weekTraffic(db: pg.Pool, fromMs: number, toMs: number): Promise<WeekTraffic> {
  return (await db.query<WeekTraffic>(
    `select (count(*) filter (where e.origin = 'work'))::int as work,
            (count(*) filter (where e.origin = 'platform'))::int as maintenance,
            (count(*) filter (where e.origin = 'work' and e.refusal_owner = 'guardrail'))::int as guardrail,
            (count(*) filter (where e.origin = 'work' and e.refusal_owner = 'ours'))::int as ours,
            (count(*) filter (where e.origin = 'work' and e.refusal_owner = 'theirs'))::int as theirs,
            (count(*) filter (where e.origin = 'work' and e.refusal_owner = 'other'))::int as other,
            (count(*) filter (where e.origin = 'platform' and e.refusal_owner is not null))::int as maintenance_refused
       from zz.event e
      where e.kind = 'tool_call' and e.ts >= $1::timestamptz and e.ts < $2::timestamptz`,
    [new Date(fromMs).toISOString(), new Date(toMs).toISOString()])).rows[0];
}

export type ToolWeek = { tool: string | null; from_ms: number; calls: number; timed: number; median_ms: number | null };

/** Real-work calls by tool and week over the whole record: the calls, as `callDays` counts them, those with a
 *  duration that is not a batch's, and their median. `tool` is null for every tool no door registers in
 *  `zz.plugin_tool`, so no other name leaves. */
export async function toolWeeks(db: pg.Pool, grid: Grid): Promise<ToolWeek[]> {
  const [days, timed] = await Promise.all([
    callDays(db, asOfOf(grid), null),
    db.query<{ tool: string | null; from_ms: number; timed: number; median_ms: number | null }>(
      `with vocabulary as (select distinct pt.door || ':' || pt.name as tool from zz.plugin_tool pt)
       select v.tool,
              (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
              (count(e.duration_ms) filter (where e.batched = false))::int as timed,
              round(percentile_cont(0.5) within group (order by e.duration_ms) filter (where e.batched = false))::float8 as median_ms
         from zz.event e
         left join vocabulary v on v.tool = e.tool_key
        where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
        group by 1, 2`, [ZZ_TZ, asOfOf(grid)]),
  ]);
  const key = (tool: string | null, fromMs: number): string => `${fromMs}/${tool ?? ""}`;
  const at = new Map(timed.rows.map((r) => [key(r.tool, r.from_ms), r]));
  return summed(days, (r) => key(r.tool, r.week_ms)).map((r) => {
    const t = at.get(key(r.tool, r.week_ms));
    return { tool: r.tool, from_ms: r.week_ms, calls: r.calls, timed: t?.timed ?? 0, median_ms: t?.median_ms ?? null };
  });
}

/** Real-work calls in `[fromMs, toMs)` by local weekday, Monday 0, and local hour. */
export async function rhythmCells(db: pg.Pool, fromMs: number, toMs: number): Promise<{ day: number; hour: number; calls: number }[]> {
  return (await db.query<{ day: number; hour: number; calls: number }>(
    `select (extract(isodow from e.ts at time zone $1::text) - 1)::int as day,
            extract(hour from e.ts at time zone $1::text)::int as hour,
            count(*)::int as calls
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts >= $2::timestamptz and e.ts < $3::timestamptz
      group by 1, 2`, [ZZ_TZ, new Date(fromMs).toISOString(), new Date(toMs).toISOString()])).rows;
}

/** Approvals recorded by week, from the grid's first week: zz-core's `document.document_approve`, which every
 *  approval writes once. The console's `document.approve` beside it is not counted, nor a maintenance client's. */
export async function approvalWeeks(db: pg.Pool, grid: Grid): Promise<{ from_ms: number; approvals: number }[]> {
  return (await db.query<{ from_ms: number; approvals: number }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as approvals
       from zz.event e
      where e.kind = 'document.document_approve' and e.origin = 'work' and e.ts >= $3::timestamptz and e.ts < $2::timestamptz
      group by 1`, [ZZ_TZ, asOfOf(grid), fromOf(grid)])).rows;
}

type ModelRow = { last: boolean; purpose: string; calls: number; failed: number; input_tokens: number; output_tokens: number };

/** The platform's own model calls of one local day (`day`, and the instant it starts), one purpose and one model. */
type ModelDay = {
  day: string; day_ms: number; purpose: string; model: string;
  calls: number; failed: number; input_tokens: number; output_tokens: number; last_ms: number;
};

/** The platform's own model calls in `[from, to)`, `from` null for the whole record, by local day, purpose and model,
 *  with the latest of each. Tokens a call did not record count as none; nothing records what a call cost. The one
 *  count of model calls Usage and the prepared query both reduce. */
export async function modelDays(db: pg.Pool, to: string, from: string | null): Promise<ModelDay[]> {
  return (await db.query<ModelDay>(
    `select to_char(m.ts at time zone $1::text, 'YYYY-MM-DD') as day,
            (extract(epoch from (date_trunc('day', m.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as day_ms,
            m.purpose, m.model,
            count(*)::int as calls,
            (count(*) filter (where not m.ok))::int as failed,
            coalesce(sum(m.input_tokens), 0)::float8 as input_tokens,
            coalesce(sum(m.output_tokens), 0)::float8 as output_tokens,
            (extract(epoch from max(m.ts)) * 1000)::float8 as last_ms
       from zz.model_call m
      where m.ts < $2::timestamptz and ($3::timestamptz is null or m.ts >= $3::timestamptz)
      group by 1, 2, 3, 4`, [ZZ_TZ, to, from])).rows;
}

/** The platform's own model calls in `[fromMs, toMs)` by purpose, `last` for those from `splitMs` on. DELIBERATE:
 *  `splitMs` is a week's first instant, a local midnight, so a day is wholly on one side of it. */
export async function modelWeeks(db: pg.Pool, fromMs: number, splitMs: number, toMs: number): Promise<ModelRow[]> {
  const out = new Map<string, ModelRow>();
  for (const d of await modelDays(db, new Date(toMs).toISOString(), new Date(fromMs).toISOString())) {
    const last = d.day_ms >= splitMs;
    const was = out.get(`${last}/${d.purpose}`) ?? { last, purpose: d.purpose, calls: 0, failed: 0, input_tokens: 0, output_tokens: 0 };
    out.set(`${last}/${d.purpose}`, {
      last, purpose: d.purpose, calls: was.calls + d.calls, failed: was.failed + d.failed,
      input_tokens: was.input_tokens + d.input_tokens, output_tokens: was.output_tokens + d.output_tokens,
    });
  }
  return [...out.values()];
}
