/**
 * What a plugin actually did, computed from the event log. Facts only — no model call anywhere
 * in this file, and no field in its output is a judgement.
 *
 * DELIBERATE: nothing here is classified. `returns: 3` is a fact; whether three returns means a
 * flow that re-grounds well or one that thrashes is not in the data. The tool counts, and the
 * ruler — written per plugin and approved by a person — says where the line is.
 *
 * Coverage travels with every figure: a number without its denominator can be wrong by three
 * orders of magnitude and look fine.
 */
import type pg from "pg";

/** How many usable runs before the trace half is worth judging.
 *
 * A floor for a signal to exist at all, not a claim about statistical power — which is why it is
 * one constant in one place and is reported beside the count it is compared against. */
const USABLE_RUNS_FLOOR = 5;

interface PluginTraces {
  runs: number;
  usable_runs: number;
  sufficient: boolean;
  coverage: { events: number; with_step: number; with_initiative: number; resolvable: number };
  stage_paths: { initiative: string; steps: { step: string; first_ts: string; last_ts: string }[] }[];
  /** Counted, never classified. See the header.
   *
   * Only over the stages that reached the door. A step is attributed from the last `skill_read`
   * a caller asked for, so a stage whose worker loaded its skill out of its own plugin directory
   * leaves no step at all — and a return is a relation between stages, so one missing stage
   * silently removes every return through it. Zero returns therefore means "no return was
   * recorded", never "the flow never went back"; read it beside `coverage` and `unplaced`. */
  returns: { initiative: string; from_step: string; back_to_step: string; ts: string }[];
  /** Steps that appear in the log and in no declared stage. Reported rather than dropped: a step
   *  nothing placed is either a stage somebody removed from the manifest or a name that has
   *  drifted, and both are worth a person's attention. */
  unplaced: { step: string; count: number }[];
  /** Per tool: how often it was called, how often it refused, and whose refusal each was.
   *
   *  A bare refusal count answers the wrong question: `guardrail` is the platform refusing on
   *  purpose, `ours` is this platform failing, and `theirs` is somebody else's service failing
   *  underneath it. Those are opposite findings with the same number. */
  use: { tool: string; calls: number; refusals: number;
         guardrail: number; ours: number; theirs: number; unattributed: number }[];
  /** Reachable, named by a skill, green on every gate check — and never called once.
   *  Reachability is a property of the package; use is a property of the runs. */
  never_called: string[];
  /** The record this door keeps, for a plugin that owns one. Null for a flow, which keeps no
   *  record of its own — it writes into somebody else's.
   *
   *  A ruler asking whether the platform's mechanism works — are documents recorded as designed,
   *  does a version change carry its cause — is asking about rows, not prose, and a threshold
   *  can only be drawn over a figure that is on the sheet. A judge reading markdown cannot see a
   *  column. */
  record: { documents: number; revised: number; revised_with_evidence: number;
            patched: number; patched_with_evidence: number } | null;
  /** Which window `use` and `never_called` were counted over — a door plugin's whole recorded
   *  history, or this version's own runs. They answer different questions and the figures are
   *  not comparable between them. */
  use_window: string;
  /** Why there is no trace evidence, when there is none — said, not left to be inferred.
   *
   * A run belongs to a plugin version through the skill versions that version shipped, so a
   * release that re-versioned every skill in a plugin starts its trace history at zero by
   * construction. That is the honest answer and it looks exactly like a broken join. Undefined
   * whenever there are runs. */
  reason?: string;
}

/** The runs belonging to one plugin version, through its recorded skill membership.
 *
 * DELIBERATE: through zz.plugin_version_skill and not through zz.event.step_version, which is
 * stamped only when a skill is served whole through skill_read. The membership is written at
 * release, which is the only moment anybody knows what a plugin version contained. */
const RUNS_BY_SKILL = `
  from zz.run r
  join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
  join zz.plugin_version pv on pv.id = pvs.plugin_version_id
  join zz.plugin p on p.id = pv.plugin_id
 where p.name = $1 and pv.version = $2`;

/** The other kind of plugin, and the other place its evidence lives.
 *
 * A flow is a sequence of stages delivering one initiative, so what it did is the runs of its own
 * skills — RUNS_BY_SKILL above. A plugin that serves a door is a backbone, used all day by every
 * other plugin's runs, and nothing it does shows up as a run of its own skills: a skill-based
 * profile of one counts its calls as somebody else's use.
 *
 * Which plugin a tool call belongs to is a fact about the door it arrived on, never an inference
 * from the caller, and `zz.event.plugin` is written from the door so the question has one answer.
 *
 * The manifest decides which shape a plugin is: one that declares `servers` owns a door; one that
 * declares none rides the baseline and is a flow. */
const RUNS_ON_DOOR = `
  from zz.run r
 where exists (select 1 from zz.event e
                where e.run_id = r.id and e.plugin = $1 and e.plugin_version = $2)`;

export async function pluginTraces(
  pool: pg.Pool, plugin: string, version: string,
  /** Tools this plugin's skills can reach, from the catalog — the gate's own rule, not a second
   *  computation of it. Passed in because it is a property of the package, and this module reads
   *  the database. */
  reachable: string[],
  /** The flow's declared stage order. A return is defined against it, so a plugin whose manifest
   *  declares none reports no returns rather than guessing an order. */
  stages: string[],
  /** Whether this plugin declares a server of its own — read from its manifest by the caller.
   *  True for zz-core, zz-access and zz-plugin-eval; false for sdlc, which reaches the baseline
   *  door. It decides where this plugin's evidence lives; see RUNS_ON_DOOR. */
  servesOwnDoor: boolean,
): Promise<PluginTraces> {
  const RUNS_OF = servesOwnDoor ? RUNS_ON_DOOR : RUNS_BY_SKILL;
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

  // One row per visit, not one per step, and the difference is the whole measurement.
  //
  // Grouping by (initiative, step) and taking min(ts) collapses every visit to a step into a
  // single row at its first entry, so the sequence is monotonic by construction and `returns` is
  // structurally zero.
  //
  // The islands form below groups consecutive runs of the same step separately: the difference
  // between "how many events have I seen in this initiative" and "how many of this step" only
  // stays constant while the step does not change, so it numbers each visit.
  const pathRows = (await pool.query<{ initiative: string; step: string; first_ts: string; last_ts: string }>(`
    select initiative, step, min(ts)::text as first_ts, max(ts)::text as last_ts
      from (select e.initiative, e.step, e.ts,
                   row_number() over (partition by e.initiative order by e.ts)
                 - row_number() over (partition by e.initiative, e.step order by e.ts) as visit
              from zz.event e
             where e.run_id in (select r.id ${RUNS_OF})
               and e.initiative is not null and e.initiative <> ''
               -- And it is an initiative name. The column holds whatever a call passed, recorded before
               -- the platform answered, so a failed call can leave a document path or a sentence in it.
               -- The shape is the platform's own: initiative_open composes the date and slug from its own
               -- clock and safeName refuses a separator.
               and e.initiative ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$'
               and e.step is not null and e.step <> '') x
     group by initiative, step, visit
     order by initiative, min(ts)`, [plugin, version])).rows;

  const stage_paths: PluginTraces["stage_paths"] = [];
  for (const row of pathRows) {
    let entry = stage_paths.find((s) => s.initiative === row.initiative);
    if (!entry) { entry = { initiative: row.initiative, steps: [] }; stage_paths.push(entry); }
    entry.steps.push({ step: row.step, first_ts: row.first_ts, last_ts: row.last_ts });
  }

  // A return is a step entered after a later-positioned step has already run. Nothing more: the
  // classification a reader wants — re-grounding or thrash — belongs to the ruler.
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

  // Through tool_key, the alias-resolved name — never the raw subject. `subject` is what the
  // caller literally typed; `tool_key` folds a rename onto one series. Read raw, one tool appears
  // twice under two spellings, and `never_called` comes out backwards: a tool in daily use under
  // its pre-rename name is reported as never called. coalesce covers rows written before the
  // column existed, where it is null.
  //
  // For a plugin with a door, counted from the door directly and not through a run: a call that
  // reached the door is use of this plugin whether or not the reconciler has since tied it to a
  // run. And across every version of the plugin — "is this tool ever actually called" is a
  // property of the surface, which barely moves between releases.
  //
  // DELIBERATE: the run-shaped figures above stay version-scoped, because those are about the
  // version — what its stages did, where it went back. `use_window` says which was asked.
  const useSource = servesOwnDoor
    ? `from zz.event e where e.plugin = $1 and e.kind = 'tool_call'`
    : `from zz.event e
        where e.run_id in (select r.id ${RUNS_BY_SKILL})
          and e.kind = 'tool_call'`;
  // The parameters the branch actually uses. The door form references $1 alone, and passing a $2
  // it never names is rejected by the server: "bind message supplies 2 parameters, but prepared
  // statement requires 1".
  const useParams = servesOwnDoor ? [plugin] : [plugin, version];
  const useRows = (await pool.query<{ tool: string; calls: string; refusals: string;
                                      guardrail: string; ours: string; theirs: string;
                                      unattributed: string }>(`
    select coalesce(e.tool_key, e.subject) as tool,
           count(*)::text as calls,
           count(*) filter (where e.ok is false)::text as refusals,
           -- Whose refusal, split three ways plus the ones nothing attributed. A row with no
           -- refusal_owner is counted as its own figure rather than folded into any of the three: a
           -- ruler drawing a line over the guardrail share needs to know how much was never attributed.
           count(*) filter (where e.ok is false and e.refusal_owner = 'guardrail')::text as guardrail,
           count(*) filter (where e.ok is false and e.refusal_owner = 'ours')::text as ours,
           count(*) filter (where e.ok is false and e.refusal_owner = 'theirs')::text as theirs,
           count(*) filter (where e.ok is false and e.refusal_owner is null)::text as unattributed
      ${useSource}
     group by coalesce(e.tool_key, e.subject)
     order by count(*) desc`, useParams)).rows;
  const use = useRows.map((r) => ({
    tool: r.tool, calls: Number(r.calls), refusals: Number(r.refusals),
    guardrail: Number(r.guardrail), ours: Number(r.ours), theirs: Number(r.theirs),
    unattributed: Number(r.unattributed) }));

  // A tool_call subject is `<surface>:<tool>` — core:document_write, manage:whoami. The reachable
  // set is bare tool names, so compare on the half after the colon.
  const called = new Set(use.map((u) => u.tool.split(":").pop() ?? u.tool));

  // A revised document is one with a frozen copy beside it. `_versions/<name>.v<N>.md` is written
  // on the draft -> approved flip, so its presence is the platform's own record of a version
  // change — the population the evidence question is about. A document written once has no
  // version change to justify.
  //
  // Only a door that writes documents has a document record to report. The figures below are the
  // store's — every document on the platform — which is zz-core's record and nobody else's, so
  // the test is the one usageDocs applies: has this door recorded a call to a tool that writes a
  // document. A door that only reads them has not produced them.
  const writesDocuments = servesOwnDoor && use.some((u) =>
    ["document_write", "document_patch", "document_revise"].includes(u.tool.split(":").pop() ?? ""));
  const rec = writesDocuments
    ? (await pool.query<{ documents: string; revised: string; revised_with_evidence: string;
                          patched: string; patched_with_evidence: string }>(`
        with live as (select * from zz.doc d where d.path not like '\\_versions/%'),
        rev as (select l.evidence,
                       exists (select 1 from zz.doc v
                                where v.team_slug = l.team_slug and v.initiative = l.initiative
                                  and v.path like '\\_versions/%' || replace(l.path, '.md', '') || '.v%') as revised,
                       exists (select 1 from zz.event e
                                where e.kind = 'tool_call' and e.ok is not false
                                  and split_part(coalesce(e.tool_key, e.subject), ':', 2) = 'document_patch'
                                  and e.initiative = l.initiative and e.team_slug = l.team_slug) as patched
                  from live l)
        select count(*)::text as documents,
               count(*) filter (where revised)::text as revised,
               count(*) filter (where revised and coalesce(array_length(evidence,1),0) > 0)::text
                 as revised_with_evidence,
               -- Which tool last touched it, because the two carry different obligations: document_revise
               -- refuses a version naming no cause, and document_patch edits the body and requires none. If
               -- the documents without evidence are the patched ones, the gap is a missing obligation on one
               -- tool rather than a rule nobody follows.
               count(*) filter (where revised and patched)::text as patched,
               count(*) filter (where revised and patched
                                  and coalesce(array_length(evidence,1),0) > 0)::text
                 as patched_with_evidence
          from rev`)).rows.map((r) => ({
            documents: Number(r.documents), revised: Number(r.revised),
            revised_with_evidence: Number(r.revised_with_evidence),
            patched: Number(r.patched),
            patched_with_evidence: Number(r.patched_with_evidence) }))[0] ?? null
    : null;

  return {
    runs,
    usable_runs: usable,
    sufficient: usable >= USABLE_RUNS_FLOOR,
    reason: runs > 0 ? undefined :
      `no run is recorded against ${plugin} ${version}. A run belongs to a version through ` +
      "the skill versions that version shipped, so a release that re-versioned this plugin's " +
      "skills starts its trace history at zero — the runs made under the previous versions " +
      "belong to those versions and are not lost. Cases need no history at all, so this is a " +
      "fact to report rather than a reason to stop.",
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
    record: rec,
    use_window: servesOwnDoor
      ? `every call recorded on this plugin's own door, across all its versions`
      : `the tool calls inside runs of this version's own skills`,
  };
}
