/**
 * One count of a team's refusals: its real-work tool calls by period, the refused among them under
 * the four owners, and its refusals grouped by owner, tool and normalised message.
 *
 * A refusal is a tool call of the team with ok false, from real work (origin work). Its owner is the
 * stored refusal_owner, and a refused row with none is counted as other, so the four owners sum to
 * the refused total by construction and no row can fall out of a sum or a chart. The maintenance the
 * platform did, every other origin, is counted apart and in no owner.
 *
 * Every function takes the team's slug, a window from one instant up to another, and the read's
 * cutoff, and counts what happened inside the window and before the cutoff. Each throws when its
 * statement fails; the read decides what a failure makes of its part.
 *
 * A message is the team's own, as stored (redacted at write): it is read for the team it belongs to
 * and no other, grouped by its normalised form and answered as the group's most recent text.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick
 * in a comment opens a template literal it then parses as code.
 *
 * COUPLED: the grouping statement spells normalizedRefusalSql("e.refusal") from @zz/contracts out as a
 * literal, because the gate holds every console query to one check:sql can PREPARE whole;
 * checks/console-refusals.ts fails when the two differ. The console's RefusalGroup and ActivitySummary
 * in src/lib/destination-shapes.ts.
 */
import { REFUSAL_OWNERS, type RefusalOwner } from "@zz/contracts";

import { platformDb } from "../db.js";
import type { Window } from "./figures.js";
import { periodsOf, type Grain } from "./work-figures.js";

/** A window as a caller names it: two instants, the first in it and the first after it. */
type Span = { from: string; to: string };
type Owners = Record<RefusalOwner, number>;
export type RefusalPeriod = { window: Window; complete: boolean; calls: number; refused: number; owners: Owners };
export type RefusalGroup = { owner: RefusalOwner; tool: string; message: string | null; count: number; lastSeen: string };

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const none = (): Owners => ({ guardrail: 0, ours: 0, theirs: 0, other: 0 });
const sum = (owners: Owners): number => REFUSAL_OWNERS.reduce((n, o) => n + owners[o], 0);

/** The team's tool calls by period at the grain: the real-work calls, refused or not, and the refused
 *  among them by owner, the owners summing to the refused total; and the maintenance calls and
 *  refusals over the whole window, in no period. */
export async function refusalWeeks(team: string, window: Span, asOf: string, grain: Grain): Promise<{
  periods: RefusalPeriod[]; maintenance: { calls: number; refused: number };
}> {
  const periods = await periodsOf(window, asOf, grain);
  // Each period counted over the part of it inside the window and before the cutoff.
  const { rows } = await platformDb().query<{ n: number; work: boolean; owner: RefusalOwner | null; calls: number }>(
    `select p.n::int as n, (e.origin = 'work') as work,
            case when e.ok = false then coalesce(e.refusal_owner, 'other') end as owner,
            count(*)::int as calls
       from unnest($2::timestamptz[], $3::timestamptz[]) with ordinality as p(lo, hi, n)
       join zz.event e on e.ts >= p.lo and e.ts < p.hi
       join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'tool_call'
      group by 1, 2, 3`,
    [team, periods.map((p) => p.window.observedFrom), periods.map((p) => p.window.observedThrough)]);
  const out = periods.map((p): RefusalPeriod => ({ window: p.window, complete: p.window.complete, calls: 0, refused: 0, owners: none() }));
  const maintenance = { calls: 0, refused: 0 };
  for (const r of rows) {
    if (!r.work) {
      maintenance.calls += r.calls;
      if (r.owner !== null) maintenance.refused += r.calls;
      continue;
    }
    const period = out[r.n - 1];
    period.calls += r.calls;
    if (r.owner !== null) period.owners[r.owner] += r.calls;
  }
  for (const p of out) p.refused = sum(p.owners);
  return { periods: out, maintenance };
}

/** The team's real-work refusals inside the window, grouped by owner, tool and normalised message,
 *  the largest first and then the most recent: the first limit answered, the rest folded into their
 *  count. A refusal recorded with no text is a group of its own, its message null, in its owner's
 *  count. */
export async function refusalGroups(team: string, window: Span, asOf: string, limit = 20): Promise<{
  rows: RefusalGroup[]; groups: number; rest: { groups: number; count: number } | null;
}> {
  const end = new Date(Math.min(Date.parse(window.to), Date.parse(asOf))).toISOString();
  const { rows } = await platformDb().query<{ owner: RefusalOwner; tool: string; message: string | null; n: number; last_ms: number }>(
    `select coalesce(e.refusal_owner, 'other') as owner, e.tool_key as tool,
            lower(regexp_replace(regexp_replace(coalesce(e.refusal, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '#', 'gi'), '[0-9]+', '#', 'g')) as normalized,
            nullif((array_agg(e.refusal order by e.ts desc, e.id desc))[1], '') as message,
            count(*)::int as n, (extract(epoch from max(e.ts)) * 1000)::float8 as last_ms
       from zz.event e
       join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'tool_call' and e.origin = 'work' and e.ok = false
        and e.ts >= $2::timestamptz and e.ts < $3::timestamptz
      group by 1, 2, 3
      order by count(*) desc, max(e.ts) desc, 1, 2, 3`,
    [team, window.from, end]);
  const all = rows.map((r): RefusalGroup => ({ owner: r.owner, tool: r.tool, message: r.message, count: r.n, lastSeen: iso(r.last_ms) }));
  const folded = all.slice(limit);
  return {
    rows: all.slice(0, limit), groups: all.length,
    rest: folded.length ? { groups: folded.length, count: folded.reduce((n, g) => n + g.count, 0) } : null,
  };
}
