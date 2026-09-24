/**
 * Skills and the runs that measured them.
 *
 * A skill's versions, what one version says, and the scores it earned — which is the largest
 * route in the console because a score is only meaningful beside what it was scored against:
 * the ruler, the judge, the affirmations, and the runs each of those came from.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { periodCutoff, teamless } from "./shared.js";

/** A SQL aggregate that saw nothing measurable, kept as null instead of becoming 0. `avg` and
 *  `sum` skip nulls and return null when every input was null, and `+null` is 0, which reads
 *  as "nothing was spent" where the honest answer is "nothing was measured". */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mountSkills(app: Express): void {
  /** Every skill the platform has run or evaluated, with what it cost to run.
   *
   * Cost first: a mean score with no idea how many calls or how long it took is a
   * number nobody can act on. The eval half may legitimately be absent — a step that
   * produces side effects leaves no document a judge can read — and an absent rubric is
   * reported as absent rather than as a zero. */
  app.get("/api/console/skills", teamless("skills", async (req, res) => {
    // No team dimension: every skill the platform has run, aggregated by skill and version
    // across every team that ran it. A skill is a platform-wide capability, so a team scope and
    // a platform scope see the identical response.
    const db = platformDb();
    // No evaluation here: zz.eval hangs off a plugin version, so nothing can write a per-skill
    // score and the plugin's scores are on the plugin.
    //
    // Windowed, like every other view, so this table and the tiles above it mean the same span.
    // A null cutoff is all time, which the picker offers.
    const since = periodCutoff(req);
    const [runs, stepEvents] = await Promise.all([
      db.query(
        // `retired` travels with the row. This view is every skill the platform has run, so a
        // skill removed from the catalog still belongs here — it owns those runs — but it must
        // not read as current.
        /* A duration is the span between a run's first and last call, so a run that made one
         * call has none: `zz.run.started_at, ended_at` are `min(e.ts), max(e.ts)` over the
         * run's events, and a one-event run is stamped `ended_at = started_at` by construction.
         *
         * So every duration below is taken `filter (where ended_at > started_at)`, and
         * `timed_runs` travels beside them, so the console can say what the median is a median
         * of rather than implying it covers the run count in the next column. All four go null
         * when a skill has no timed run — unknown, not instant.
         *
         * One decimal, not zero: `round(...,0)` makes a genuine sub-second median
         * indistinguishable from the structural kind above.
         *
         * DELIBERATE: no `teams` column. This route is `teamless`, and `array_agg(distinct
         * t.slug)` is not a fact about the skill but a list of the other teams on the
         * deployment. The gate check for a `teamless` body looks for a filter on team_slug, so
         * an aggregated team column passes it. */
        `select s.name, sv.version, s.kind, s.flow, s.retired,
                count(*)                                            as runs,
                count(*) filter (where r.ended_at > r.started_at)   as timed_runs,
                coalesce(sum(r.calls),0)                            as calls,
                round(avg(r.calls)::numeric,1)                      as calls_avg,
                coalesce(max(r.calls),0)                            as calls_max,
                coalesce(sum(r.refusals),0)                         as refusals,
                round(avg(extract(epoch from (r.ended_at-r.started_at)))
                      filter (where r.ended_at > r.started_at)::numeric,1) as dur_avg,
                round(percentile_cont(0.5) within group
                      (order by extract(epoch from (r.ended_at-r.started_at)))
                      filter (where r.ended_at > r.started_at)::numeric,1) as dur_med,
                round(max(extract(epoch from (r.ended_at-r.started_at)))
                      filter (where r.ended_at > r.started_at)::numeric,1) as dur_max,
                round(sum(extract(epoch from (r.ended_at-r.started_at)))
                      filter (where r.ended_at > r.started_at)::numeric,1) as dur_total,
                round(avg(r.bytes_total)/1024.0,1)                  as kb_avg,
                round((sum(r.bytes_total)/1048576.0)::numeric,1)    as mb_total
           from zz.run r
           join zz.skill_version sv on sv.id = r.skill_version_id
           join zz.skill s on s.id = sv.skill_id
          where ($1::timestamptz is null or r.started_at >= $1)
          group by 1,2,3,4,5`, [since]),
      db.query(
        // The same window as the runs above, or `logged` would report all-time call counts
        // beside a windowed run count on one row.
        `select step, count(*) as calls, count(*) filter (where ok = false) as failed,
                count(distinct coalesce(tool_key, subject)) as tools
           from zz.event where kind = 'tool_call' and step is not null and step <> ''
             and ($1::timestamptz is null or ts >= $1)
          group by 1`, [since]),
    ]);
    const evBy = new Map(stepEvents.rows.map((e) => [e.step as string, e]));
    res.json({ skills: runs.rows.map((r) => {
      const ev = evBy.get(r.name as string);
      return {
        name: r.name, version: r.version, kind: r.kind, flow: r.flow,
        // Emitted, not merely selected: a `retired` column the response does not carry leaves
        // the view listing a retired skill exactly as it lists one still served.
        retired: !!r.retired,
        runs: +r.runs, calls: +r.calls, callsAvg: +r.calls_avg, callsMax: +r.calls_max,
        // How many of those runs a duration can be computed for — see the query.
        timedRuns: +r.timed_runs,
        refusals: +r.refusals,
        // Null is not zero, for every aggregate that can come back SQL-null: `+null` is 0, so
        // a plain `+r.x` reads "nothing in this group was measured" as "instant and free".
        // Tested against null rather than against 0, because a real zero is meaningful here —
        // measured, and empty.
        durationAvg: num(r.dur_avg), durationMedian: num(r.dur_med), durationMax: num(r.dur_max),
        durationTotal: num(r.dur_total),
        kbPerRun: num(r.kb_avg), mbTotal: num(r.mb_total),
        logged: ev ? { calls: +ev.calls, failed: +ev.failed, tools: +ev.tools } : null,
      };
    }) });
  }));

  /** One skill: which surfaces its calls went to, and which tools it leans on.
   *
   * No rubric and no findings: both belong to a plugin version now, so nothing can write a
   * per-skill score or finding. The scores are on the plugin. */
  app.get("/api/console/skills/:name", teamless("the skill", async (req, res) => {
    // DELIBERATE: no team dimension. A skill's call mix is a property of the skill itself, aggregated
    // across every team that ran it — see /skills above.
    const db = platformDb();
    const name = req.params.name;
    const [mix, top] = await Promise.all([
      db.query(
        // The door comes from `subject`, which is `<door>:<tool>` on every tool_call and is
        // always present.
        `select split_part(coalesce(tool_key, subject),':',1) as surface, count(*) as calls,
                count(*) filter (where ok = false) as failed,
                count(distinct coalesce(tool_key, subject)) as tools
           from zz.event where kind = 'tool_call' and step = $1
          group by 1 order by count(*) desc`, [name]),
      db.query(
        `select coalesce(tool_key, subject) as tool, count(*) as calls,
                count(*) filter (where ok = false) as failed
           from zz.event where kind = 'tool_call' and step = $1
          group by 1 order by count(*) desc limit 8`, [name]),
    ]);
    res.json({
      skill: name,
      surfaces: mix.rows.map((m) => ({ surface: m.surface, calls: +m.calls, failed: +m.failed, tools: +m.tools })),
      busiestTools: top.rows.map((t) => ({ tool: t.tool, calls: +t.calls, failed: +t.failed })),
    });
  }));

  /* DELIBERATE: there is no per-skill scores route, and adding one keyed on a skill under a
   * plugin would invite the per-skill comparison the design refuses — every ruler belongs to
   * one plugin, and two skills' numbers under two rulers are not comparable.
   */
  /** Runs, as recorded.
   *
   * No outcome breakdown: `zz.run` has no outcome column and nothing writes one, so a
   * breakdown would be one bar reading "(not recorded)" forever. */
  app.get("/api/console/runs", teamless("runs", async (req, res) => {
    // No team dimension: `zz.run` carries no team column, and this reports platform-wide
    // volume totals, the same census category as /overview.
    //
    // COUPLED: windowed with /skills. These four totals sit directly above the per-skill table
    // on one page, so two spans on one page would read as two figures for one thing.
    const db = platformDb();
    const since = periodCutoff(req);
    const [totals] = await Promise.all([
      // COUPLED: no model-turn column and no caveat built on one — nothing writes zz.run's
      // model-turn count and nothing emits the matching event, so a banner watching it could
      // never clear. checks/console-nulls.ts refuses a reader here again.
      db.query(`select count(*) as runs, coalesce(sum(calls),0) as calls,
                       coalesce(sum(refusals),0) as refusals,
                       round((sum(bytes_total)/1048576.0)::numeric,1) as mb
                  from zz.run
                 where ($1::timestamptz is null or started_at >= $1)`, [since]),
    ]);
    const t = totals.rows[0];
    res.json({
      totals: { runs: +t.runs, calls: +t.calls, refusals: +t.refusals, mb: num(t.mb) },
    });
  }));
}
