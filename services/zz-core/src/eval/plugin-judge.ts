/**
 * The legacy ordinal round, read back: `round_scores` is the one reader left for every `zz.eval`,
 * `zz.eval_score` and `zz.rubric*` row a round ever wrote (spec FR-7, plan I-10).
 *
 * The tools that wrote those rows are gone — `round_judge` marked a version against the
 * `zz.rubric` it declared, `round_score` computed the two axes onto `zz.eval`. Nothing mints a
 * new round any more: a plugin is scored through the protocol lifecycle
 * (`evaluation_start`/`evaluation_assess`/`evaluation_score`, `evaluate.ts`). What stays is the
 * history, exactly as readable as it was.
 *
 * COUPLED: `plugin-eval.ts` holds the half that returns no judgement — every field there is a
 * count, a set, an ordering or a difference. This file returns judgements, all of them stored.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { effectiveness, headroom } from "./judge-score.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing about a " +
                        "plugin's evaluation can be read");


export function registerPluginJudgeTools(server: McpServer): void {
  server.registerTool(
    "round_scores",
    {
      description:
        "WHEN a HISTORIC ordinal round (a zz.eval row from before the protocol lifecycle) " +
        "has to be read back — no new round is minted any more. RETURNS " +
        "the round itself, the qualitative dimensions with their means, the judge on trial " +
        "against its blind control, every quantitative dimension with the threshold it was " +
        "held to and the figure it was read against, and the findings recorded so far — " +
        "stored facts, retrieved, every judgement made by the pinned judge at the time and " +
        "nothing re-scored here. REFUSES an eval_id that is not a plugin evaluation, and the " +
        "control is counted separately and never averaged into the real mean.",
      inputSchema: { eval_id: z.string() },
    },
    async ({ eval_id }) => {
      const p = db();
      if (!p) return noDb();
      const round = (await p.query<{ plugin: string; version: string; rubric: string; judge: string;
                                     is_control: boolean; started: string; finished: string | null;
                                     doc_count: number; plugin_version_id: string }>(`
        select p.name as plugin, pv.version, rb.version as rubric, ev.judge_model as judge,
               ev.is_control, ev.started_at::text as started, ev.finished_at::text as finished,
               ev.doc_count, ev.plugin_version_id::text as plugin_version_id
          from zz.eval ev
          join zz.plugin_version pv on pv.id = ev.plugin_version_id
          join zz.plugin p on p.id = pv.plugin_id
          join zz.rubric rb on rb.id = ev.rubric_id
         where ev.id = $1::uuid`, [eval_id])).rows[0];
      if (!round) {
        return text(`ERROR: ${eval_id} is not an evaluation round of a plugin. This reads only the ` +
                    "historic ordinal rounds on zz.eval; a protocol-driven run is read through " +
                    "evaluation_score.");
      }
      const pvId = round.plugin_version_id;
      // Across every round of this plugin version, not this round alone. A round resumes and a
      // control is its own row, so the gap between the real mean and the control's cannot be
      // computed inside a single eval.
      const dimensions = (await p.query<{ rubric: string; judge: string; dimension: string;
                                          n: string; mean: string; worst: string; best: string }>(`
        select rb.version as rubric, ev.judge_model as judge, d.name as dimension,
               count(*)::text as n, round(avg(sc.score),2)::text as mean,
               min(sc.score)::text as worst, max(sc.score)::text as best
          from zz.eval_score sc
          join zz.eval ev on ev.id = sc.eval_id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.rubric_dimension d on d.id = sc.dimension_id
         where ev.plugin_version_id = $1::uuid and sc.is_control is false and d.kind = 'qualitative'
         group by 1,2,3,d.ordinal order by 1,2,d.ordinal`, [pvId])).rows;
      // Qualitative only. A quantitative dimension reads the version's computed facts and never
      // the artifact, so it scores identically whichever artifact is in front of the judge;
      // folding it into both arms would shrink the gap by arithmetic.
      //
      // This round against its own control, when the control named it: a gap is a property of one
      // round. The pooled form is the fallback and is labelled as such, because every round
      // recorded before the link existed has none and was always measured that way.
      const paired = (await p.query<{ rubric: string; judge: string; real_mean: string | null;
                                      control_mean: string | null }>(`
        select rb.version as rubric, ev.judge_model as judge,
               round(avg(sc.score) filter (where sc.eval_id = $1::uuid),2)::text as real_mean,
               round(avg(sc.score) filter (where sc.eval_id = ctl.id),2)::text as control_mean
          from zz.eval ev
          join zz.eval ctl on ctl.controls = ev.id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.eval_score sc on sc.eval_id in (ev.id, ctl.id)
          join zz.rubric_dimension d on d.id = sc.dimension_id and d.kind = 'qualitative'
         where ev.id = $1::uuid
         group by 1,2`, [eval_id])).rows;
      const trial = paired.length ? paired : (await p.query<{ rubric: string; judge: string;
                                     real_mean: string | null; control_mean: string | null }>(`
        select rb.version as rubric, ev.judge_model as judge,
               round(avg(sc.score) filter (where sc.is_control is false),2)::text as real_mean,
               round(avg(sc.score) filter (where sc.is_control is true),2)::text as control_mean
          from zz.eval_score sc
          join zz.eval ev on ev.id = sc.eval_id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.rubric_dimension d on d.id = sc.dimension_id
         where ev.plugin_version_id = $1::uuid and d.kind = 'qualitative'
         group by 1,2 having count(*) filter (where sc.is_control is true) > 0`, [pvId])).rows;
      // Round by round. A second real round re-applies every threshold, so an ungrouped listing
      // shows each dimension twice with nothing saying which reading is today's.
      const thresholds = (await p.query<{ round: string; rubric: string; judge: string; when: string;
                                          dimension: string; threshold: string; reason: string;
                                          score: number; fact: string }>(`
        select ev.id::text as round, rb.version as rubric, ev.judge_model as judge,
               ev.started_at::text as when,
               d.name as dimension, d.threshold, d.threshold_reason as reason,
               sc.score, sc.quote as fact
          from zz.eval_score sc
          join zz.eval ev on ev.id = sc.eval_id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.rubric_dimension d on d.id = sc.dimension_id
         where ev.plugin_version_id = $1::uuid and d.kind = 'quantitative'
           and sc.is_control is false
         order by ev.started_at, d.ordinal`, [pvId])).rows;
      const findings = (await p.query<{ pattern: string; scope: string; docs_affected: number;
                                        proposed_change: string; decision: string }>(`
        select pattern, scope, docs_affected, proposed_change, decision
          from zz.eval_finding where eval_id = $1::uuid order by created_at`, [eval_id])).rows;
      // The two numbers a person actually asked for, computed here from what is already above.
      // The recommendation enum is a decision, not a measurement: how-good-is-it and
      // what-is-left-to-fix are independent. See judge-score.ts for the weights and the bands,
      // which are fixed before any round is read.
      //
      // This round's own figures, not the pooled ones. `dimensions` above groups by rubric and
      // judge across every round under this version, which would score a second round partly on
      // the first.
      const thisRound = dimensions.filter((d) => d.rubric === round.rubric && d.judge === round.judge);
      const qualMean = thisRound.length
        ? Math.round((thisRound.reduce((a, d) => a + Number(d.mean), 0) / thisRound.length) * 100) / 100
        : null;
      const mine = thresholds.filter((t) => t.round === eval_id);
      const met = mine.filter((t) => t.score >= 5).length;
      const gapNow = trial[0]?.real_mean && trial[0]?.control_mean
        ? Number((Number(trial[0].real_mean) - Number(trial[0].control_mean)).toFixed(2)) : null;
      const effective = effectiveness(qualMean, met, mine.length, gapNow);
      const room = headroom(effective.score, mine.length - met,
                            findings.filter((f) => f.scope === "generic").length);

      return json({
        eval_id, round,
        // First in the answer, because it is the first question. Everything below is what it was
        // computed from, in the order somebody would check it.
        effectiveness: effective,
        headroom: room,
        dimensions,
        judge_on_trial: trial.map((t) => ({
          ...t,
          gap: t.real_mean && t.control_mean
            ? Number((Number(t.real_mean) - Number(t.control_mean)).toFixed(2)) : null,
          // Which rounds the number is over: a reader comparing two reports needs to know whether
          // a gap is this round's or an average across every round under the ruler.
          over: paired.length ? "this round and the control that names it"
                              : "every round under this ruler, pooled - no control names this one",
        })),
        // Met is 5 and unmet is 1 because a line is binary; the reason is the ruler's own
        // threshold_reason, recorded when the line was drawn.
        thresholds: thresholds.map((t) => ({ ...t, meets: t.score >= 5 })),
        findings,
        note: trial.length
          ? "The gap is the only number that says the judge was reading rather than rewarding " +
            "confident output. Below 1.5 the ruler failed to tell the right artifact from the " +
            "wrong one, and nothing else here establishes anything."
          : "NO CONTROL was run against this plugin version, so nothing establishes the " +
            "judge was reading. Treat every score above as unverified.",
      });
    },
  );
}
