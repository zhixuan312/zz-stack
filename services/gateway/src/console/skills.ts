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

/** A SQL aggregate that saw nothing measurable, kept as null instead of becoming 0.
 *  `avg`/`sum` skip nulls and return null when every input was null, and `+null` is 0 — so
 *  the unary plus this replaces was quietly reporting "nothing was spent" for a group where
 *  the honest answer is "nothing was measured". */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mountSkills(app: Express): void {
  /** Every skill the platform has run or evaluated, with what it cost to run.
   *
   * COST FIRST. A mean score with no idea how many calls or how long it took is
   * a number nobody can act on, and it was the first thing asked for when this
   * view was reviewed. The eval half may legitimately be absent — ops-build
   * produces side effects, not a document a judge can read — and an absent
   * rubric is reported as absent rather than as a zero. */
  app.get("/api/console/skills", teamless("skills", async (req, res) => {
    // NO TEAM DIMENSION: this is every skill the platform has run, aggregated by skill and
    // version across every team that ran it. A skill is a platform-wide capability, not a
    // team's own data, so a team scope and a platform scope see the identical response.
    const db = platformDb();
    // NO EVALUATION HERE ANY MORE. This listed a mean, a control and a judge per skill
    // version, from an evaluation whose subject WAS a skill. That subject no longer exists:
    // zz.eval hangs off a plugin version now, and nothing can ever write a per-skill score
    // again. A column that can only show what was measured before the change, on a page that
    // reads as current, is worse than an absent one — so it is absent. The plugin's scores are
    // on the plugin.
    // WINDOWED, like every other view. This route had no period at all and the Runs page
    // hid the picker to match, so "every skill, side by side" silently meant "since the
    // platform was installed" — a comparison nobody asked for beside tiles that all mean
    // the last 24 hours. Null is still all time; the picker simply has an all-time option.
    const since = periodCutoff(req);
    const [runs, stepEvents] = await Promise.all([
      db.query(
        // `retired` travels with the row. This view is "every skill the platform has RUN",
        // so a skill removed from the catalog still belongs here — it owns those runs, and
        // dropping it would silently re-attribute its history. What it must not do is read
        // as current: casebox-stg-usage and zz-learn both appear here and neither is served any
        // more, and nothing on the row said so.
        /* A DURATION IS THE SPAN BETWEEN A RUN'S FIRST AND LAST CALL, so a run that made one
         * call has no span to report. `zz.run.started_at, ended_at` are `min(e.ts), max(e.ts)`
         * over the run's events (runs.ts) and one event yields one timestamp — such a run is
         * stamped `ended_at = started_at` by construction, not because anything failed to be
         * measured. On this deployment that is 148 of 336 runs, and the set is EXACTLY the
         * runs with `calls = 1`: checked both directions, zero rows disagree.
         *
         * Folding those structural zeroes in is not a rounding error. sdlc-plan has 40 runs,
         * 6 of them with more than one call; its median over all 40 is 0s and its median over
         * those 6 is 5423s. The view was reporting 0 for a skill whose typical measurable run
         * takes ninety minutes. So every duration below is taken `filter (where ended_at >
         * started_at)`, and `timed_runs` travels beside them so the console can say what the
         * median is a median OF rather than implying it covers the run count in the next
         * column. All four go null when a skill has no timed run — unknown, not instant,
         * the same rule the bytes aggregates follow.
         *
         * ONE DECIMAL, not zero. `round(...,0)` turned every sub-second median into a 0 that
         * is indistinguishable from the structural kind above: sdlc-explore has 38 timed runs
         * and a genuine median under a second, and it deserves to say so.
         *
         * NO `teams` COLUMN, AND THERE MUST NOT BE ONE. This route is `teamless` — a skill is a
         * platform-wide capability, so its run counts are the same figure for every caller —
         * and it also returned `array_agg(distinct t.slug)`, which is not a fact about the
         * skill but a list of the OTHER TEAMS on the deployment. A member of one team asking
         * which skills exist learned that team `quan` exists, which skills it runs and how
         * often. The console never read the field; it was payload nobody asked for carrying
         * the one thing this route may not say. The gate check for a `teamless` body looks
         * for a FILTER on team_slug, so an aggregated team column passed it. */
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
        // SAME WINDOW as the runs above, or `logged` would report all-time call counts
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
        // EMITTED, not merely selected. The column was added to the query and to nothing
        // else, so the view kept listing casebox-stg-usage and zz-learn exactly as it lists a
        // skill that is still served — which is the state the column was added to end.
        retired: !!r.retired,
        runs: +r.runs, calls: +r.calls, callsAvg: +r.calls_avg, callsMax: +r.calls_max,
        // How many of those runs a duration can be computed for — see the query.
        timedRuns: +r.timed_runs,
        refusals: +r.refusals,
        // NULL IS NOT ZERO, for every aggregate that can come back SQL-null. `+null` is 0,
        // so a plain `+r.x` reads "no run in this group was ever measured" as "this skill is
        // instant and free" — the exact conflation migration 051 removed from
        // zz.run.bytes_total, one layer up. Tested against null rather than against 0,
        // because here a real zero IS meaningful: measured, and empty.
        durationAvg: num(r.dur_avg), durationMedian: num(r.dur_med), durationMax: num(r.dur_max),
        durationTotal: num(r.dur_total),
        kbPerRun: num(r.kb_avg), mbTotal: num(r.mb_total),
        logged: ev ? { calls: +ev.calls, failed: +ev.failed, tools: +ev.tools } : null,
      };
    }) });
  }));

  /** One skill: which surfaces its calls went to, and which tools it leans on.
   *
   * ITS RUBRIC AND ITS FINDINGS USED TO BE HERE and are gone, because the thing they were
   * about is gone. A rubric hung off a skill and an evaluation's subject WAS a skill version;
   * both now belong to a plugin, and nothing can write a per-skill score or a per-skill
   * finding again. Leaving the sections in would have shown, on a page that reads as current,
   * whatever happened to be measured before the change and then nothing ever after — which is
   * a worse answer than the absence, because a reader cannot tell an empty result from a
   * retired question. The scores are on the plugin now. */
  app.get("/api/console/skills/:name", teamless("the skill", async (req, res) => {
    // NO TEAM DIMENSION: a skill's call mix is a property of the skill itself, aggregated
    // across every team that ran it — see /skills above.
    const db = platformDb();
    const name = req.params.name;
    const [mix, top] = await Promise.all([
      db.query(
        // THE DOOR, FROM `subject`, WHICH IS ALWAYS PRESENT. This read `block`, a column nothing
        // has written since attribution became a fact about the door — so every row fell into one
        // `platform` bucket and the split reported a composition of one. `subject` is
        // `<door>:<tool>` on every tool_call.
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

  /* /api/console/skills/:name/scores WAS HERE, and it went with its subject.
   *
   * It listed every document a skill produced, scored or not, and its whole argument was that
   * the unscored ones are the interesting half: "ops-intent has 81 intent.md documents in the
   * store and 30 of them have ever been judged, and a page that only lists the 30 reports a
   * mean over a sample it does not disclose." That argument is still right and it is now the
   * plugin's to make — an evaluation's subject is a plugin version, so a score keyed on a
   * skill is a score nothing can write.
   *
   * NOT REPOINTED AT A PLUGIN, deliberately. A scores page keyed on a skill, nested under a
   * plugin, would be the old taxonomy wearing the new word: it would invite exactly the
   * per-skill comparison the new design refuses, because every ruler now belongs to one
   * plugin and two skills' numbers under two rulers are not comparable.
   */
  /** Runs, as recorded.
   *
   * NO OUTCOME BREAKDOWN. This grouped every run by `zz.run.outcome` and reported the runs
   * that ended without one as a gap. 048 drops that column: its only writer was the
   * `eval-decide` op, which went with the skill-level evaluation, and nothing has set a run's
   * outcome since. A breakdown of a column nothing writes is one bar reading "(not recorded)"
   * across every run forever, and a "gap" that can never close is not a gap — it is a feature
   * nobody built, reported as a defect. If the platform decides a run has an outcome again,
   * this comes back with whatever writes it. */
  app.get("/api/console/runs", teamless("runs", async (req, res) => {
    // NO TEAM DIMENSION: `zz.run` carries no team column and this reports platform-wide
    // volume totals, the same census category as /overview.
    //
    // WINDOWED WITH /skills, and it has to be: these four totals sit directly above the
    // per-skill table on one page. While this answered all time and that one took a period,
    // the page could read "336 runs" in a tile and "26 runs" in the panel's own header an
    // inch below it — two true numbers about different spans, with nothing saying so.
    const db = platformDb();
    const since = periodCutoff(req);
    const [totals] = await Promise.all([
      // NO MODEL-TURN COLUMN AND NO CAVEAT BUILT ON ONE. zz.run's model-turn count was
      // written by nothing — no statement anywhere set it — and nothing emitted the matching
      // event either, so the "not attributed to runs" banner this used to build could never
      // clear: a warning watching a column no code will ever fill. Both halves are gone
      // rather than reported, because a caveat the platform cannot act on teaches the reader
      // to skip the ones it can. checks/console-nulls.ts refuses a reader here again.
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
