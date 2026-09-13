/**
 * WHAT A PLUGIN ACTUALLY DID, computed from the event log. Facts only — no model call anywhere
 * in this file, and no field in its output is a judgement.
 *
 * That boundary is the design, not a style preference. `returns: 3` is a fact: sdlc-spec-audit
 * ran and then sdlc-spec ran again. Whether three returns means a flow that re-grounds well or
 * one that thrashes is NOT IN THE DATA — the initiative that produced this module returned
 * three times and every one was healthy. So the tool counts and the ruler, written per plugin
 * and approved by a person, says where the line is. A field called `healthy` here would be this
 * module answering a question it cannot see the evidence for.
 *
 * COVERAGE TRAVELS WITH EVERY FIGURE, and that rule was bought expensively. zz.run reported 1805
 * rows when four were real; every query that read it read a healthy-looking table, for weeks. A
 * number without its denominator can be wrong by three orders of magnitude and look fine.
 */
import type pg from "pg";

/** How many usable runs before the trace half is worth judging.
 *
 * A floor for a signal to exist at all, not a claim about statistical power — which is why it is
 * one constant in one place and is reported beside the count it is compared against, so a person
 * can disagree with the line rather than with the arithmetic. */
const USABLE_RUNS_FLOOR = 5;

interface PluginTraces {
  runs: number;
  usable_runs: number;
  sufficient: boolean;
  coverage: { events: number; with_step: number; with_initiative: number; resolvable: number };
  stage_paths: { initiative: string; steps: { step: string; first_ts: string; last_ts: string }[] }[];
  /** Counted, never classified. See the header.
   *
   * AND ONLY OVER THE STAGES THAT REACHED THE DOOR. A step is attributed from the last
   * `skill_view` a caller asked for, so a stage whose worker loaded its skill out of its own
   * plugin directory left no step at all — and a return is a relation BETWEEN stages, so one
   * missing stage silently removes every return through it. Measured on 2026-09-13: zz.event
   * holds no `sdlc-spec-audit` or `sdlc-plan-audit` row in its whole history, so every
   * spec → audit → spec on this platform reads here as a straight line. Zero returns is
   * therefore "no return was recorded", never "the flow never went back"; read it beside
   * `coverage` and `unplaced` rather than on its own. */
  returns: { initiative: string; from_step: string; back_to_step: string; ts: string }[];
  /** Steps that appear in the log and in no declared stage. Reported rather than dropped: a step
   *  nothing placed is either a stage somebody removed from the manifest or a name that has
   *  drifted, and both are worth a person's attention. */
  unplaced: { step: string; count: number }[];
  use: { tool: string; calls: number; refusals: number }[];
  /** Reachable, named by a skill, green on every gate check — and never called once. This is the
   *  half of fit no static check can see: reachability is a property of the package, use is a
   *  property of the runs. */
  never_called: string[];
}

/** The runs belonging to one plugin version, through its recorded skill membership.
 *
 * Through zz.plugin_version_skill and NOT through zz.event.step_version, which is stamped only
 * when a skill is served whole through skill_view and has been frozen at 39 rows while the event
 * log grew by a third. The membership is written at release, which is the only moment anybody
 * actually knows what a plugin version contained. */
const RUNS_OF = `
  from zz.run r
  join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
  join zz.plugin_version pv on pv.id = pvs.plugin_version_id
  join zz.plugin p on p.id = pv.plugin_id
 where p.name = $1 and pv.version = $2`;

export async function pluginTraces(
  pool: pg.Pool, plugin: string, version: string,
  /** Tools this plugin's skills can reach, from the catalog — the gate's own rule, not a second
   *  computation of it. Passed in because it is a property of the package, and this module reads
   *  the database. */
  reachable: string[],
  /** The flow's declared stage order. A return is defined against it, so a plugin whose manifest
   *  declares none reports no returns rather than guessing an order. */
  stages: string[],
): Promise<PluginTraces> {
  const n = async (sql: string): Promise<number> =>
    Number((await pool.query<{ n: string }>(sql, [plugin, version])).rows[0]?.n ?? 0);

  const runs = await n(`select count(*)::text as n ${RUNS_OF}`);
  const usable = await n(`
    select count(*)::text as n ${RUNS_OF}
      and r.initiative_id is not null
      and exists (select 1 from zz.event e
                   where e.run_id = r.id and e.step is not null and e.step <> '')`);

  // Coverage over the events these runs own. `resolvable` is the count that can be placed on a
  // stage at all; the gap between it and `events` is what every other figure here is missing.
  const cov = (await pool.query<{ events: string; with_step: string; with_initiative: string; resolvable: string }>(`
    select count(*)::text                                                            as events,
           count(*) filter (where e.step is not null and e.step <> '')::text          as with_step,
           count(*) filter (where e.initiative is not null and e.initiative <> '')::text as with_initiative,
           count(*) filter (where exists (select 1 from zz.skill s where s.name = e.step))::text as resolvable
      from zz.event e
     where e.run_id in (select r.id ${RUNS_OF})`, [plugin, version])).rows[0];

  // ONE ROW PER VISIT, NOT ONE PER STEP, and the difference is the whole measurement.
  //
  // This grouped by (initiative, step) and took min(ts). That collapses every visit to a step
  // into a single row at its FIRST entry -- so a stage entered, left, and entered again appears
  // once, the sequence is monotonic by construction, and `returns` is structurally zero. It
  // shipped that way and returned 0 against live data, which looked like an answer.
  //
  // The islands form below groups CONSECUTIVE runs of the same step separately: the difference
  // between "how many events have I seen in this initiative" and "how many of this step" only
  // stays constant while the step does not change, so it numbers each visit. Two visits to
  // sdlc-spec with an audit between them are two rows, which is what a return is made of.
  const pathRows = (await pool.query<{ initiative: string; step: string; first_ts: string; last_ts: string }>(`
    select initiative, step, min(ts)::text as first_ts, max(ts)::text as last_ts
      from (select e.initiative, e.step, e.ts,
                   row_number() over (partition by e.initiative order by e.ts)
                 - row_number() over (partition by e.initiative, e.step order by e.ts) as visit
              from zz.event e
             where e.run_id in (select r.id ${RUNS_OF})
               and e.initiative is not null and e.initiative <> ''
               and e.step is not null and e.step <> '') x
     group by initiative, step, visit
     order by initiative, min(ts)`, [plugin, version])).rows;

  const stage_paths: PluginTraces["stage_paths"] = [];
  for (const row of pathRows) {
    let entry = stage_paths.find((s) => s.initiative === row.initiative);
    if (!entry) { entry = { initiative: row.initiative, steps: [] }; stage_paths.push(entry); }
    entry.steps.push({ step: row.step, first_ts: row.first_ts, last_ts: row.last_ts });
  }

  // A RETURN is a step entered after a later-positioned step has already run. Nothing more:
  // the classification a reader wants -- was that re-grounding or thrash -- belongs to the
  // ruler, and this initiative's own three returns were all healthy.
  const at = new Map(stages.map((s, i) => [s, i]));
  const returns: PluginTraces["returns"] = [];
  const unplacedCount = new Map<string, number>();
  for (const path of stage_paths) {
    let furthest = -1;
    let furthestStep = "";
    for (const s of path.steps) {
      const pos = at.get(s.step);
      if (pos === undefined) {
        unplacedCount.set(s.step, (unplacedCount.get(s.step) ?? 0) + 1);
        continue;
      }
      if (pos < furthest) {
        returns.push({ initiative: path.initiative, from_step: furthestStep, back_to_step: s.step, ts: s.first_ts });
      } else { furthest = pos; furthestStep = s.step; }
    }
  }

  const useRows = (await pool.query<{ tool: string; calls: string; refusals: string }>(`
    select e.subject as tool,
           count(*)::text as calls,
           count(*) filter (where e.ok is false)::text as refusals
      from zz.event e
     where e.run_id in (select r.id ${RUNS_OF})
       and e.kind = 'tool_call'
     group by e.subject
     order by count(*) desc`, [plugin, version])).rows;
  const use = useRows.map((r) => ({ tool: r.tool, calls: Number(r.calls), refusals: Number(r.refusals) }));

  // A tool_call subject is `<surface>:<tool>` -- core:write_file, manage:whoami. The reachable
  // set is bare tool names, so compare on the half after the colon.
  const called = new Set(use.map((u) => u.tool.split(":").pop() ?? u.tool));

  return {
    runs,
    usable_runs: usable,
    sufficient: usable >= USABLE_RUNS_FLOOR,
    coverage: {
      events: Number(cov?.events ?? 0),
      with_step: Number(cov?.with_step ?? 0),
      with_initiative: Number(cov?.with_initiative ?? 0),
      resolvable: Number(cov?.resolvable ?? 0),
    },
    stage_paths,
    returns,
    unplaced: [...unplacedCount].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count),
    use,
    never_called: reachable.filter((t) => !called.has(t)).sort(),
  };
}
