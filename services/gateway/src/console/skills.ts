/**
 * Skills and the runs that measured them.
 *
 * A skill's versions, what one version says, and the scores it earned — which is the largest
 * route in the console because a score is only meaningful beside what it was scored against:
 * the ruler, the judge, the affirmations, and the runs each of those came from.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { teamless } from "./shared.js";

export function mountSkills(app: Express): void {
  /** Every skill the platform has run or evaluated, with what it cost to run.
   *
   * COST FIRST. A mean score with no idea how many calls or how long it took is
   * a number nobody can act on, and it was the first thing asked for when this
   * view was reviewed. The eval half may legitimately be absent — ops-build
   * produces side effects, not a document a judge can read — and an absent
   * rubric is reported as absent rather than as a zero. */
  app.get("/api/console/skills", teamless("skills", async (_req, res) => {
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
    const [runs, stepEvents] = await Promise.all([
      db.query(
        // `retired` travels with the row. This view is "every skill the platform has RUN",
        // so a skill removed from the catalog still belongs here — it owns those runs, and
        // dropping it would silently re-attribute its history. What it must not do is read
        // as current: casebox-stg-usage and zz-learn both appear here and neither is served any
        // more, and nothing on the row said so.
        `select s.name, sv.version, s.kind, s.flow, s.retired,
                count(*)                                            as runs,
                coalesce(sum(r.calls),0)                            as calls,
                round(avg(r.calls)::numeric,1)                      as calls_avg,
                coalesce(max(r.calls),0)                            as calls_max,
                coalesce(sum(r.refusals),0)                         as refusals,
                coalesce(sum(r.turns),0)                            as turns,
                round(avg(extract(epoch from (r.ended_at-r.started_at)))::numeric,0) as dur_avg,
                round(percentile_cont(0.5) within group
                      (order by extract(epoch from (r.ended_at-r.started_at)))::numeric,0) as dur_med,
                round(max(extract(epoch from (r.ended_at-r.started_at)))::numeric,0) as dur_max,
                round(avg(r.bytes_total)/1024.0,1)                  as kb_avg,
                round((sum(r.bytes_total)/1048576.0)::numeric,1)    as mb_total
           from zz.run r
           join zz.skill_version sv on sv.id = r.skill_version_id
           join zz.skill s on s.id = sv.skill_id
          group by 1,2,3,4,5`),
      db.query(
        `select step, count(*) as calls, count(*) filter (where ok = false) as failed,
                count(distinct subject) as tools
           from zz.event where kind = 'tool_call' and step is not null and step <> ''
          group by 1`),
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
        refusals: +r.refusals,
        // Reported as null, never 0. zz.run.turns is zero on every row while the
        // event log holds turn events with no run id, so a 0 here would read as
        // "this skill used no LLM turns" — which is false, not merely unknown.
        turns: +r.turns > 0 ? +r.turns : null,
        durationAvg: +r.dur_avg, durationMedian: +r.dur_med, durationMax: +r.dur_max,
        kbPerRun: +r.kb_avg, mbTotal: +r.mb_total,
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
        `select coalesce(block,'platform') as surface, count(*) as calls,
                count(*) filter (where ok = false) as failed, count(distinct subject) as tools
           from zz.event where kind = 'tool_call' and step = $1
          group by 1 order by count(*) desc`, [name]),
      db.query(
        `select subject as tool, count(*) as calls,
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
  /** Runs, as recorded. States the one gap it still has rather than hiding it: turns that are
   * never attributed.
   *
   * NO OUTCOME BREAKDOWN. This grouped every run by `zz.run.outcome` and reported the runs
   * that ended without one as a gap. 048 drops that column: its only writer was the
   * `eval-decide` op, which went with the skill-level evaluation, and nothing has set a run's
   * outcome since. A breakdown of a column nothing writes is one bar reading "(not recorded)"
   * across every run forever, and a "gap" that can never close is not a gap — it is a feature
   * nobody built, reported as a defect. If the platform decides a run has an outcome again,
   * this comes back with whatever writes it. */
  app.get("/api/console/runs", teamless("runs", async (_req, res) => {
    // NO TEAM DIMENSION: `zz.run` carries no team column and this reports platform-wide
    // volume totals, the same census category as /overview.
    const db = platformDb();
    const [totals] = await Promise.all([
      db.query(`select count(*) as runs, coalesce(sum(calls),0) as calls,
                       coalesce(sum(refusals),0) as refusals, coalesce(sum(turns),0) as turns,
                       round((sum(bytes_total)/1048576.0)::numeric,1) as mb,
                       (select count(*) from zz.event where kind='turn') as turn_events
                  from zz.run`),
    ]);
    const t = totals.rows[0];
    res.json({
      totals: { runs: +t.runs, calls: +t.calls, refusals: +t.refusals, mb: +t.mb },
      gaps: {
        // Both stated as data so the front end never has to hardcode a caveat
        // that stops being true the day the platform starts recording them.
        //
        // A GAP YOU CANNOT HAVE IS NOT A GAP. This was `+t.turns > 0` alone, which is false
        // on a platform that has never run anything — so a fresh install opened its Runs page
        // to a warning banner reading "zz.run.turns is 0 on all 0 rows, while the event log
        // holds 0 turn events", reporting a defect where there is simply no data yet. Nothing
        // is unattributed when nothing exists, and a caveat that fires on emptiness teaches
        // the reader to ignore the ones that mean something.
        turnsAttributed: +t.turns > 0 || (+t.runs === 0 && +t.turn_events === 0),
        turnEvents: +t.turn_events,
      },
    });
  }));
}
