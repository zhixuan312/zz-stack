/**
 * THE TWO TOOLS THAT WRITE DOWN WHAT A PERSON DECIDED.
 *
 * Everything else in the plugin evaluation reads: it counts runs, reads a recorded delta, marks
 * artifacts against a ruler. These two are where a judgement made by somebody comes back into
 * the platform as a row — the ruler the define stage derived, and the findings the report stage
 * concluded. They are their own subject for that reason, and not because plugin-judge.ts got
 * long: the tools there answer "what is true of this plugin", these answer "what did a person
 * decide about it", and the second is not a smaller version of the first.
 *
 * BOTH REFUSE INCOMPLETE INPUT, and for the same reason at both ends. A quantitative dimension
 * with no threshold, or a threshold with no stated reason, is a line somebody can move later
 * to make a result come out differently and nobody would be able to tell. A finding scoped
 * generic that proposes no change claims the plugin has a habit worth changing it over and
 * leaves the next round nothing to test against. Both are refused at RECORDING time, because
 * the alternative is refusing at judging time, and by then the figures exist.
 *
 * NEITHER IS APPROVING. A ruler is recorded, then put to a person, then affirmed. A finding
 * lands deferred. The platform holds what was decided; it does not decide.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { ask, configured, NOT_CONFIGURED, type ChoiceQuestion, type ScoreQuestion } from "./typesafe.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing can be recorded");

export function registerPluginRecordTools(server: McpServer): void {
  server.registerTool(
    "ruler_record",
    {
      description:
        "WHEN rulers.md says what good means for this plugin, and BEFORE the stakeholder " +
        "approves — approving is `ruler_affirm`'s job and it is a separate act. It writes the " +
        "ruler the define stage derived into the registry so the judge can be run against it, " +
        "and RETURNS the dimensions as they now stand. Each dimension is qualitative (a reader " +
        "scores 1-5 between two written ends) or quantitative (a tool computes a fact and this " +
        "carries the line drawn over it, with the reason it was drawn there). REFUSES a " +
        "quantitative dimension with no threshold. Re-recording replaces the dimensions of the " +
        "ruler at the same rubric version.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        rubric_version: z.string().describe("this ruler's own version, e.g. \"1\""),
        subject: z.enum(["auto", "document", "trace", "initiative"])
          .describe("what the qualitative dimensions are applied to"),
        dimensions: z.array(z.object({
          name: z.string(),
          kind: z.enum(["qualitative", "quantitative"]),
          /** 2-10 ORDERED level descriptions, low end first. This is what a qualitative
           *  dimension IS — a scale somebody can place an artifact on — and it replaces the
           *  two-ends form below, which left the rungs between them to whoever was marking. */
          levels: z.array(z.string()).min(2).max(10).optional(),
          /** The two-ends form. Kept for the rulers written before levels existed; a NEW
           *  qualitative dimension must send `levels`. */
          five_means: z.string().optional(),
          one_means: z.string().optional(),
          threshold: z.string().optional(),
          threshold_reason: z.string().optional(),
        })).min(1),
      },
    },
    async ({ plugin, version, rubric_version, subject, dimensions }) => {
      const p = db();
      if (!p) return noDb();

      // VALIDATED HERE AND NOT AT JUDGING TIME, because judging time is too late: by then the
      // figures exist, and a threshold written after them is a number somebody chose knowing
      // the answer. Nobody afterwards can tell that from one chosen before.
      const bad: string[] = [];
      for (const d of dimensions) {
        if (d.kind === "quantitative") {
          if (!d.threshold?.trim()) {
            bad.push(`${d.name}: quantitative and carries no threshold — a tool computes the ` +
                     "figure, and this is where the line over it is drawn");
          }
          if (!d.threshold_reason?.trim()) {
            bad.push(`${d.name}: quantitative and carries no threshold_reason — a line with no ` +
                     "stated reason is a number somebody can move later to make a result come " +
                     "out differently, and nobody would be able to tell");
          }
        } else if (!d.levels?.length) {
          // NAME EVERY LEVEL, for 016_reference.sql's own reason one step further on: "a
          // dimension a marker cannot place is a dimension that gets placed by mood." Two ends
          // and a number do not place the middle — they leave three rungs to the marker's
          // taste, and two rounds then mark the same artifact differently for no recorded
          // reason. A level that cannot be described is one nobody should be asked to award.
          bad.push(`${d.name}: qualitative and carries no levels — give 2-10 ordered level ` +
                   "descriptions, low end first. Two ends and a 1-5 scale leave the rungs " +
                   "between them to whoever is marking, and that is where two rounds stop " +
                   "being comparable");
        } else if (d.levels.some((l) => !l.trim())) {
          bad.push(`${d.name}: a level is blank — every level a marker may award has to say ` +
                   "what it means");
        }
      }
      if (bad.length) return text(`REFUSED: ${bad.join("; ")}`);

      const pv = (await p.query<{ id: string; plugin_id: string }>(`
        select pv.id::text as id, p.id::text as plugin_id
          from zz.plugin p join zz.plugin_version pv on pv.plugin_id = p.id
         where p.name = $1 and pv.version = $2`, [plugin, version])).rows[0];
      if (!pv) return text(`ERROR: no released version ${version} of "${plugin}" is recorded`);

      const rubricId = (await p.query<{ id: string }>(`
        insert into zz.rubric (plugin_id, version, subject) values ($1::uuid, $2, $3)
        on conflict (plugin_id, version) do update set subject = excluded.subject
        returning id::text as id`, [pv.plugin_id, rubric_version, subject])).rows[0].id;

      // REPLACED, not merged — and BY NAME, because a score points at a dimension row.
      //
      // This deleted every dimension and re-inserted them, which is right about the ruler and
      // wrong about the database: zz.eval_score carries a foreign key to rubric_dimension.id,
      // so the moment a round has been scored the delete fails and the caller gets a raw
      // Postgres constraint name instead of a sentence. It is not a rare corner either — it
      // is what "reuse this plugin's existing ruler" runs into the first time it is tried,
      // which is the path ruler_read itself tells the define stage to take.
      //
      // So a dimension that is still in the ruler is UPDATED IN PLACE and keeps its id, which
      // is also the more honest record: a score taken against "document depth" stays attached
      // to "document depth" rather than to a row that was deleted and replaced by one that
      // happens to read the same.
      //
      // A dimension the new draft drops is deleted — leaving it behind would score the plugin
      // against a line nobody currently holds — unless something has already been scored
      // against it, and then the caller is told to move to a new rubric version rather than
      // have history rewritten underneath them.
      const existing = (await p.query<{ id: string; name: string; scored: string }>(`
        select d.id::text as id, d.name,
               (select count(*)::text from zz.eval_score s where s.dimension_id = d.id) as scored
          from zz.rubric_dimension d where d.rubric_id = $1::uuid`, [rubricId])).rows;
      const keep = new Set(dimensions.map((d) => d.name));
      const orphaned = existing.filter((e) => !keep.has(e.name) && Number(e.scored) > 0);
      if (orphaned.length) {
        return text(
          `REFUSED: ${orphaned.map((o) => `"${o.name}"`).join(", ")} ` +
          `${orphaned.length === 1 ? "has" : "have"} already been scored under rubric ` +
          `version ${rubric_version}, so dropping ${orphaned.length === 1 ? "it" : "them"} ` +
          "would leave marks pointing at a line nobody holds. Record this as a NEW " +
          "rubric_version instead — the old scale keeps its scores and the new one starts " +
          "clean, which is what makes two rounds comparable or honestly incomparable.");
      }
      const byName = new Map(existing.map((e) => [e.name, e.id]));
      for (const e of existing) if (!keep.has(e.name)) {
        await p.query("delete from zz.rubric_dimension where id = $1::uuid", [e.id]);
      }
      for (const [i, d] of dimensions.entries()) {
        const id = byName.get(d.name);
        if (id) {
          await p.query(`
            update zz.rubric_dimension
               set five_means = $2, one_means = $3, ordinal = $4, kind = $5,
                   threshold = $6, threshold_reason = $7, levels = $8::text[]
             where id = $1::uuid`,
            [id, d.five_means ?? "", d.one_means ?? "", i,
             d.kind, d.threshold ?? "", d.threshold_reason ?? "", d.levels ?? null]);
        } else {
          await p.query(`
            insert into zz.rubric_dimension
              (rubric_id, name, five_means, one_means, ordinal, kind, threshold, threshold_reason, levels)
            values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text[])`,
            [rubricId, d.name, d.five_means ?? "", d.one_means ?? "", i,
             d.kind, d.threshold ?? "", d.threshold_reason ?? "", d.levels ?? null]);
        }
      }

      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "ruler_record", plugin, version,
          rubric: rubric_version, dimensions: dimensions.length });
      return json({
        plugin, version, rubric_id: rubricId, rubric_version, subject,
        qualitative: dimensions.filter((d) => d.kind === "qualitative").length,
        quantitative: dimensions.filter((d) => d.kind === "quantitative").length,
        next: "Put rulers.md to the stakeholder. Nothing is scored until ruler_affirm records " +
              "that they agreed to it.",
      });
    },
  );

  server.registerTool(
    "finding_record",
    {
      description:
        "WHEN the scores are in and the report stage has decided what the pattern is. It " +
        "records what this round found as rows the NEXT round can read, and RETURNS them as " +
        "stored. Each finding is generic (it recurs across unrelated work, so it is the " +
        "plugin's habit and worth changing the plugin over) or specific (one piece of work's " +
        "own problem). A finding on somebody else's plugin carries no proposed_change — we " +
        "assess and stop. REFUSES an eval_id nothing minted. Recording is not deciding: a " +
        "finding lands deferred, and applying or rejecting it is a separate act by whoever " +
        "owns the plugin.",
      inputSchema: {
        eval_id: z.string(),
        findings: z.array(z.object({
          pattern: z.string().describe("what recurred, in one sentence"),
          docs_affected: z.number().int().min(0).optional(),
          scope: z.enum(["generic", "specific"]),
          proposed_change: z.string().optional()
            .describe("one change, and what you expect it to do. Omit for a third-party plugin."),
          decision: z.enum(["applied", "rejected", "deferred"]).optional(),
        })).min(1),
      },
    },
    async ({ eval_id, findings }) => {
      const p = db();
      if (!p) return noDb();
      const ev = (await p.query<{ id: string }>(
        "select id::text as id from zz.eval where id = $1::uuid", [eval_id])).rows[0];
      if (!ev) return text(`ERROR: no evaluation ${eval_id}`);

      // A GENERIC FINDING WITH NO PROPOSED CHANGE IS AN OBSERVATION, and the distinction is
      // load-bearing. `generic` claims the plugin has a habit worth changing it over; saying so
      // and then naming no change leaves the next round nothing to test against, and a finding
      // nothing can contradict reads as vindicated whatever happens next. `specific` may stand
      // alone -- one piece of work's own problem is fixed by doing that work better, not by
      // editing a plugin.
      const mute = findings.filter((f) => f.scope === "generic" && !f.proposed_change?.trim());
      if (mute.length) {
        return text(
          `REFUSED: ${mute.length} finding(s) are scoped generic and propose no change — ` +
          `${mute.map((f) => JSON.stringify(f.pattern.slice(0, 60))).join(", ")}. Generic means ` +
          "this is the plugin's habit and worth changing the plugin over; say what change, and " +
          "what you expect it to move. If you cannot, it is an observation about one round — " +
          "scope it specific, or leave it in the prose of findings.md where a reader can weigh " +
          "it without the platform treating it as a claim about the plugin.");
      }

      let stored = 0;
      for (const f of findings) {
        await p.query(`
          insert into zz.eval_finding (eval_id, pattern, docs_affected, scope, proposed_change, decision)
          values ($1::uuid, $2, $3, $4, $5, $6)`,
          [eval_id, f.pattern, f.docs_affected ?? 0, f.scope,
           f.proposed_change ?? "", f.decision ?? "deferred"]);
        stored++;
      }
      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "finding_record", eval_id, findings: stored });
      return json({
        eval_id, recorded: stored,
        generic: findings.filter((f) => f.scope === "generic").length,
        specific: findings.filter((f) => f.scope === "specific").length,
        next: "These are DEFERRED. Nothing here changes the plugin — the catalog is read-only " +
              "wherever the platform runs, and a change is a repository edit and a release by " +
              "whoever owns it.",
      });
    },
  );

  server.registerTool(
    "round_recommend",
    {
      description:
        "WHEN a round's marks and findings are in and the report needs its one-word verdict. " +
        "It assembles what this round actually established — the dimension means, the judge's " +
        "own control gap, every threshold and whether it was met, the case delta and the trace " +
        "window — and puts them to the TYPED judgement service as a closed choice, then " +
        "records what came back. RETURNS the recommendation, the probability of every option " +
        "and the confidence, which is the shape of that distribution and not the model's " +
        "opinion of itself. YOU DO NOT CHOOSE THE WORD: the enum is `keep`, `keep-and-change`, " +
        "`re-run`, `not-evaluable`, `retire`, and which one this evidence supports is the " +
        "judgement being outsourced. Writing the paragraph that explains it is yours. REFUSES " +
        "an eval_id nothing minted; reports the judgement as ABSENT, without failing, when the " +
        "deployment has no key for the service.",
      inputSchema: { eval_id: z.string() },
    },
    async ({ eval_id }) => {
      const p = db();
      if (!p) return noDb();
      const round = (await p.query<{
        plugin: string; version: string; rubric: string; judge: string; is_control: boolean;
      }>(`
        select pl.name as plugin, pv.version, rb.version as rubric, e.judge_model as judge,
               e.is_control
          from zz.eval e
          join zz.plugin_version pv on pv.id = e.plugin_version_id
          join zz.plugin pl on pl.id = pv.plugin_id
          join zz.rubric rb on rb.id = e.rubric_id
         where e.id = $1::uuid`, [eval_id])).rows[0];
      if (!round) return text(`ERROR: no plugin evaluation ${eval_id}`);
      if (round.is_control) {
        return text(
          "ERROR: that eval_id is the CONTROL run. A control marks another plugin's work to " +
          "test whether the ruler discriminates; it is not the round being recommended on. " +
          "Pass the real round's eval_id — round_scores shows both.");
      }

      // WHAT THIS ROUND ESTABLISHED, read back rather than re-derived. Every figure here is
      // already stored: the means the judge produced, the control it was tried against, the
      // thresholds with the line each was held to. Re-deriving any of them would let the
      // recommendation rest on numbers the report never showed.
      const dims = (await p.query<{ dimension: string; kind: string; mean: string; n: string;
                                    confidence: string | null }>(`
        select d.name as dimension, d.kind, round(avg(s.score),2)::text as mean,
               count(*)::text as n, round(avg(s.confidence),2)::text as confidence
          from zz.eval_score s join zz.rubric_dimension d on d.id = s.dimension_id
         where s.eval_id = $1::uuid and not s.is_control
         group by d.name, d.kind, d.ordinal order by d.ordinal`, [eval_id])).rows;
      const control = (await p.query<{ real: string | null; ctl: string | null }>(`
        select round(avg(s.score) filter (where not s.is_control),2)::text as real,
               round(avg(s.score) filter (where s.is_control),2)::text as ctl
          from zz.eval_score s
          join zz.rubric_dimension d on d.id = s.dimension_id and d.kind <> 'quantitative'
         where s.eval_id in (
                 select e2.id from zz.eval e2
                  where e2.plugin_version_id = (select plugin_version_id from zz.eval where id = $1::uuid)
                    and e2.rubric_id = (select rubric_id from zz.eval where id = $1::uuid))`,
        [eval_id])).rows[0];
      const findings = (await p.query<{ scope: string; pattern: string }>(
        "select scope, pattern from zz.eval_finding where eval_id = $1::uuid", [eval_id])).rows;

      const gap = control?.real && control?.ctl
        ? Math.round((Number(control.real) - Number(control.ctl)) * 100) / 100 : null;
      const state = [
        `Plugin under evaluation: ${round.plugin} ${round.version}, marked against rubric ` +
        `version ${round.rubric} by judge ${round.judge}.`,
        dims.length
          ? "Dimension results: " + dims.map((d) => `${d.dimension} (${d.kind}) mean ${d.mean} ` +
              `over ${d.n} mark(s)` + (d.confidence ? `, judge confidence ${d.confidence}` : "")).join("; ") + "."
          : "No dimension produced a mark in this round.",
        gap === null
          ? "No blind control was run, so nothing establishes whether the ruler can tell this " +
            "plugin's work from another plugin's."
          : `Judge on trial: the real subjects averaged ${control?.real} and the blind control ` +
            `averaged ${control?.ctl}, a gap of ${gap}. A gap below 1.5 means the ruler failed ` +
            "to tell the right artifact from the wrong one and the round establishes nothing.",
        findings.length
          ? `Findings recorded: ${findings.length} (` +
            findings.map((f) => `${f.scope}: ${f.pattern}`).join(" | ").slice(0, 1200) + ")."
          : "No findings were recorded against this round.",
      ].join(" ");

      // ABSENCE IS AN ANSWER. A deployment with no key still produces a report; it produces one
      // that says the typed judgement was not taken and why, which a reader can act on. A
      // report that refuses to exist because a third party is unreachable is a dependency
      // nobody agreed to.
      if (!configured()) {
        return json({
          eval_id, plugin: round.plugin, version: round.version,
          recommendation: null, absent: NOT_CONFIGURED,
          state_that_would_have_been_asked: state,
          next: "Write the report without a recommendation and say in section 1 that the typed " +
                "judgement was not taken, and why. Do not substitute your own word for it — " +
                "an enum chosen in prose is the thing this tool exists to stop.",
        });
      }

      const questions: Record<string, ChoiceQuestion | ScoreQuestion> = {
        recommendation: {
          type: "choice",
          instructions: "A plugin evaluation has finished. Choose the single recommendation this evidence supports.",
          criteria: {
            "keep": "Working as intended; the evidence supports leaving it exactly as it is.",
            "keep-and-change": "Valuable and worth keeping, but the evidence identifies specific defects to fix.",
            "re-run": "The evidence exists but THIS round is not usable — a void control, or a round taken on evidence since corrected — so the measurement should be taken again before any verdict.",
            "not-evaluable": "The evidence needed to judge this plugin does not exist at all, so no verdict about the plugin can honestly be given.",
            "retire": "It costs more than it returns; remove it.",
          },
        },
        evidence_strength: {
          type: "score",
          instructions: "How strong is the body of evidence behind this verdict?",
          criteria: ["No usable evidence", "Thin — one source only", "Adequate", "Strong across two independent sources"],
        },
      };
      let rec, strength;
      try {
        const answers = await ask(state, questions);
        rec = answers.recommendation;
        strength = answers.evidence_strength;
      } catch (err) {
        return text(String((err as Error).message));
      }
      if (rec?.type !== "choice") return text("ERROR: the typed judgement service did not answer a choice");

      await p.query(`
        update zz.eval set recommendation = $2, recommendation_confidence = $3,
                           recommendation_probabilities = $4::jsonb
         where id = $1::uuid`,
        [eval_id, rec.choice, rec.confidence, JSON.stringify(rec.probabilities)]);

      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "round_recommend", eval_id, plugin: round.plugin,
          version: round.version, recommendation: rec.choice, confidence: rec.confidence });

      return json({
        eval_id, plugin: round.plugin, version: round.version,
        recommendation: rec.choice,
        confidence: rec.confidence,
        probabilities: rec.probabilities,
        evidence_strength: strength?.type === "score"
          ? { score: strength.score, legend: strength.legend, confidence: strength.confidence }
          : null,
        judge_on_trial_gap: gap,
        next: "The word and its confidence are recorded. Section 1 of findings.md carries them " +
              "verbatim; the paragraph underneath is yours to write, from these numbers and " +
              "from reading the artifacts — never a different verdict reached in prose.",
      });
    },
  );
}
