/**
 * Skills and the active team's runs of them.
 *
 * Through `platformPublic`: a skill is the platform's, the same for everybody, and every figure here
 * is counted over the caller's active team's runs and calls alone. A person in no team is refused.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { skillsOf } from "./catalog.js";
import { periodCutoff, platformPublic } from "./shared.js";

/** A SQL aggregate that saw nothing measurable, kept as null instead of becoming 0. `avg` and
 *  `sum` skip nulls and return null when every input was null, and `+null` is 0, which reads
 *  as "nothing was spent" where the honest answer is "nothing was measured". */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mountSkills(app: Express): void {
  /** Every skill the active team has run, by skill and version, with how its runs went; `plugin`
   * narrows it to the skills that plugin ships, and a plugin this image does not ship answers none. */
  app.get("/api/console/skills", platformPublic("skills", async (req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: "no team: Work is the active team's, and you act for none" });
      return;
    }
    const plugin = req.query.plugin;
    if (plugin !== undefined && typeof plugin !== "string") {
      res.status(400).json({ error: "plugin is one plugin's name, given once" });
      return;
    }
    // Null is every skill; a list, possibly empty, is the named plugin's.
    const names = plugin === undefined ? null : skillsOf(plugin);
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
        //
        // `kind` is derived, not read: `zz.skill.flow` is the whole of a skill's catalog shape
        // (a skill that names a flow is a step of that flow's method, one that names none is
        // standalone capability) and the column it duplicates was dropped. The field name the
        // response carries is unchanged, so the view reads as it did.
        /* A duration is the span between a run's first and last call, so a run that made one
         * call has none: `zz.skill_run.started_at, ended_at` are `min(e.ts), max(e.ts)` over the
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
         * The active team's runs alone: another team's runs of the same skill change nothing here. */
        `select s.name, sv.version,
                case when s.flow is null then 'plugin_skill' else 'flow_step' end as kind,
                s.flow, s.retired,
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
           from zz.skill_run r
           join zz.skill_version sv on sv.id = r.skill_version_id
           join zz.skill s on s.id = sv.skill_id
           join zz.team t on t.id = r.team_id
          where ($1::timestamptz is null or r.started_at >= $1)
            and t.slug = $2
            and ($3::text[] is null or s.name = any($3))
          group by 1,2,3,4,5
          order by 1,2`, [since, activeTeam, names]),
      db.query(
        // The same window as the runs above, or `logged` would report all-time call counts
        // beside a windowed run count on one row.
        //
        // A call's step is the skill of the version the event names, resolved through
        // `zz.skill_version` — the retired `step` text is gone. An event naming no skill version
        // is a step this cannot name, and it is left out of every group rather than folded onto
        // one; that gap is on the run side too, where `runs` counts what `logged` cannot reach.
        // The calls are the team's real work, as /plugins counts them: a maintenance client's call is no use of a skill.
        `select s.name as step, count(*) as calls, count(*) filter (where e.ok = false) as failed,
                count(distinct coalesce(e.tool_key, e.subject)) as tools
           from zz.event e
           join zz.skill_version v on v.id = e.skill_version_id
           join zz.skill s on s.id = v.skill_id
           join zz.team t on t.id = e.team_id
          where e.kind = 'tool_call' and e.origin = 'work' and t.slug = $2
            and ($1::timestamptz is null or e.ts >= $1)
          group by 1`, [since, activeTeam]),
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

  /** One skill: which surfaces the active team's calls of it went to, and which tools it leans on.
   *
   * No rubric and no findings: both belong to a plugin version now, so nothing can write a
   * per-skill score or finding. The scores are on the plugin. */
  app.get("/api/console/skills/:name", platformPublic("the skill", async (req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: "no team: Work is the active team's, and you act for none" });
      return;
    }
    const db = platformDb();
    const name = req.params.name;
    const [mix, top] = await Promise.all([
      db.query(
        // The door comes from `subject`, which is `<door>:<tool>` on every tool_call and is
        // always present.
        //
        // The step is the skill's name, resolved through the version the event names — the
        // retired `step` text is gone. An event naming no skill version belongs to no skill here,
        // for the same reason it belongs to no group in the query above.
        `select split_part(coalesce(e.tool_key, e.subject),':',1) as surface, count(*) as calls,
                count(*) filter (where e.ok = false) as failed,
                count(distinct coalesce(e.tool_key, e.subject)) as tools
           from zz.event e
           join zz.skill_version v on v.id = e.skill_version_id
           join zz.skill s on s.id = v.skill_id
           join zz.team t on t.id = e.team_id
          where e.kind = 'tool_call' and e.origin = 'work' and s.name = $1 and t.slug = $2
          group by 1 order by count(*) desc`, [name, activeTeam]),
      db.query(
        `select coalesce(e.tool_key, e.subject) as tool, count(*) as calls,
                count(*) filter (where e.ok = false) as failed
           from zz.event e
           join zz.skill_version v on v.id = e.skill_version_id
           join zz.skill s on s.id = v.skill_id
           join zz.team t on t.id = e.team_id
          where e.kind = 'tool_call' and e.origin = 'work' and s.name = $1 and t.slug = $2
          group by 1 order by count(*) desc limit 8`, [name, activeTeam]),
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
}
