/**
 * The tools that write down what a person (or EVALUATE itself) decided: the findings a round or
 * an `eval_run` concluded, what became of each finding, and the verdict a legacy round ends on.
 * Everything else in the plugin evaluation reads.
 *
 * Task I-10 removed `ruler_record`, which used to live here — writing `zz.rubric*` for the
 * define stage, ahead of `ruler_affirm`. `protocol_record` (`protocol.ts`) is what writes a
 * plugin's measurement object now, into `zz.eval_protocol_version` and never `zz.rubric*`.
 *
 * Task I-13 replaces `finding_record`'s own shape: a finding now belongs to one `eval_run_id`
 * (migration 078's `zz.eval_finding.eval_run_id`, alongside the legacy `eval_id` `round_score`
 * still reads — see 078's own header for the dual-lifecycle shape), names its `kind`
 * (strength/defect/unknown, not the legacy `scope`), and REQUIRES `owner_kind` at recording time
 * rather than leaving ownership to a later pass. This is a breaking change: the OLD
 * `finding_record(eval_id, findings: [...])` shape this file used to accept is gone, not carried
 * forward under an alias — no caller of the legacy round pipeline ever wrote a new-pipeline
 * finding, and the reverse was never true either.
 *
 * `finding_decide` now writes through the FR-59 idempotency ledger like every other mutator on
 * this door — the plan's own words, "finding_decide joins the idempotency ledger" — closing
 * either lifetime's finding by the same `id`, since `zz.eval_finding.id` names one row whichever
 * column points at it.
 *
 * It does not approve. A finding lands `deferred`. The platform holds what was decided.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EVAL_STATE_ENUMS, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { writeFindingsDoc } from "./findings-doc.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";
import { ask, configured, NOT_CONFIGURED, type ScoreQuestion } from "../typed-service.js";
import { effectiveness, headroom, headroomNote } from "./judge-score.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing can be recorded");

export function registerPluginRecordTools(server: McpServer): void {
  server.registerTool(
    "finding_record",
    {
      description:
        "WHEN evaluation_score (or a round's report stage, for a strength/defect/unknown found " +
        "against an eval_run) has decided what the pattern is. It records ONE finding against " +
        "eval_run_id and RETURNS it as stored, DEFERRED — recording is not deciding, and " +
        "applying or rejecting it is a separate act by whoever owns it. `kind` is strength " +
        "(what is working), defect (what is wrong) or unknown (evidence does not say which). " +
        "`owner_kind` is REQUIRED: a finding on somebody else's plugin/dependency/platform/ " +
        "environment/user_input carries no expected_effect — assess and stop. Pass `initiative` " +
        "to regenerate that initiative's findings.md from this eval_run's current score and " +
        "every finding recorded against it so far — omit it to record without touching the " +
        "document. REFUSES an eval_run_id nothing minted and a call missing owner_kind. A " +
        "mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        eval_run_id: z.string(),
        finding: z.object({
          kind: z.enum(EVAL_STATE_ENUMS.findingKind),
          pattern: z.string().describe("what this run found, in one sentence"),
          owner_kind: z.enum(EVAL_STATE_ENUMS.ownerKind),
          owner_ref: z.string().optional().describe("which plugin/dependency/etc, when owner_kind names one"),
          measure_id: z.string().optional().describe("the zz.eval_measure this finding is evidence for, if one"),
          evidence_refs: z.array(z.string()).default([]),
          expected_effect: z.record(z.string(), z.unknown()).optional()
            .describe("what changing this is expected to move — omit when owner_kind is not 'plugin'"),
        }),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe("regenerate <initiative>/findings.md after recording"),
      },
    },
    async ({ eval_run_id, finding, idempotency_key, initiative }) => {
      const p = db();
      if (!p) return noDb();
      const run = (await p.query<{ id: string }>(
        "select id::text as id from zz.eval_run where id = $1::uuid", [eval_run_id])).rows[0];
      if (!run) return text(`ERROR: no eval_run ${eval_run_id}`);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ id: string; kind: string; pattern: string }> = await withIdempotency(
        principal, "finding_record", idempotency_key, { eval_run_id, finding },
        async (client): Promise<MutatorOutcome<{ id: string; kind: string; pattern: string }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.eval_finding
              (eval_run_id, kind, pattern, owner_kind, owner_ref, measure_id, evidence_refs,
               expected_effect, decision)
            values ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb, 'deferred')
            returning id::text as id`,
            [eval_run_id, finding.kind, finding.pattern, finding.owner_kind, finding.owner_ref ?? null,
             finding.measure_id ?? null, JSON.stringify(finding.evidence_refs ?? []),
             finding.expected_effect ? JSON.stringify(finding.expected_effect) : null])).rows[0];
          if (!row) throw new Error("insert into zz.eval_finding produced no row");
          return {
            result: { id: row.id, kind: finding.kind, pattern: finding.pattern },
            result_table: "zz.eval_finding", result_id: row.id,
          };
        },
      );

      let result: { id: string; kind: string; pattern: string };
      if (outcome.replayed) {
        const row = (await p.query<{ id: string; kind: string; pattern: string }>(
          "select id::text as id, kind, pattern from zz.eval_finding where id = $1::uuid", [outcome.result_id])).rows[0];
        if (!row) throw new Refusal("ERROR: idempotency ledger points at a finding this call cannot read back");
        result = row;
      } else {
        result = outcome.result;
      }

      let doc: { path: string; chars: number } | string | undefined;
      if (initiative) doc = await writeFindingsDoc(p, initiative, eval_run_id);

      logActivity(await userRoot(), null, {
        user: principal, action: "finding_record", eval_run_id, finding_id: result.id, replayed: outcome.replayed,
      });
      return json({
        eval_run_id, finding: result,
        findings_md: doc === undefined ? undefined : typeof doc === "string" ? { refused: doc } : doc,
        next: "This finding is DEFERRED. It stays open, counting against this plugin's headroom, " +
              "until finding_decide records that somebody applied or rejected it.",
      });
    },
  );

  server.registerTool(
    "finding_decide",
    {
      description:
        "WHEN somebody who owns the finding has applied the change it named, or has decided not " +
        "to. It closes those findings — from either lifetime, a legacy round's or an EVALUATE " +
        "run's — and RETURNS each as it now stands, with who decided and when. This is the act " +
        "finding_record's own description promises and nothing performed: a finding lands " +
        "`deferred` and stays there until this is called. REFUSES an id nothing minted, a " +
        "finding already decided, and `deferred` as a decision — deferring is where a finding " +
        "starts, so choosing it here would be a decision that changes nothing while looking like " +
        "one that did. A note is required for both real decisions, because `applied` with no " +
        "change named and `rejected` with no reason are the two ways this ledger stops being " +
        "readable. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        decisions: z.array(z.object({
          finding_id: z.string().describe("from finding_record, or round_score's open_changes"),
          decision: z.enum(["applied", "rejected"]),
          note: z.string().describe(
            "applied: what was changed and where — a version, a file, a release. " +
            "rejected: why this is not worth doing."),
        })).min(1),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ decisions, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const blank = decisions.filter((d) => !d.note.trim());
      if (blank.length) {
        return text(
          `REFUSED: ${blank.length} decision(s) carry no note. An \`applied\` that does not say ` +
          "what changed cannot be checked by the next round, and a `rejected` that does not say " +
          "why is indistinguishable from the finding being forgotten. Both close a change " +
          "somebody proposed; say what happened to it.");
      }
      const who = parseCaller(requestHeaders()).email;

      interface DecidedRow { id: string; pattern: string; decision: string; at: string }
      const outcome: IdempotencyOutcome<{ done: (DecidedRow & { decided_by: string; note: string })[]; refused: string[] }> =
        await withIdempotency(
          who, "finding_decide", idempotency_key, { decisions },
          async (client): Promise<MutatorOutcome<{ done: (DecidedRow & { decided_by: string; note: string })[]; refused: string[] }>> => {
            const done: (DecidedRow & { decided_by: string; note: string })[] = [];
            const refused: string[] = [];
            for (const d of decisions) {
              // One statement, guarded in the where clause. Reading the row and then updating it
              // would let two callers deciding the same finding both see `deferred` and both write.
              const row = (await client.query<DecidedRow>(`
                update zz.eval_finding
                   set decision = $2, decision_note = $3, decided_by = $4, decided_at = now()
                 where id = $1::uuid and decision = 'deferred'
                returning id::text as id, pattern, decision, decided_at::text as at`,
                [d.finding_id, d.decision, d.note.trim(), who])).rows[0];
              if (row) { done.push({ ...row, decided_by: who, note: d.note.trim() }); continue; }
              // Which of the two, because they need opposite responses: an unknown id is a caller
              // working from the wrong round, an already-decided one is about to undo someone's work.
              const was = (await client.query<{ decision: string; by: string | null; note: string }>(
                "select decision, decided_by as by, decision_note as note from zz.eval_finding where id = $1::uuid",
                [d.finding_id])).rows[0];
              refused.push(was
                ? `${d.finding_id} was already ${was.decision}${was.by ? ` by ${was.by}` : ""}` +
                  `${was.note ? ` — "${was.note}"` : ""}. Reopening a decided finding is not something ` +
                  "this tool does: record what the next round found instead."
                : `${d.finding_id} names no finding. Ids come from finding_record, or from the ` +
                  "open_changes round_score returns.");
            }
            if (!done.length) throw new Refusal(`REFUSED: none of the ${decisions.length} decision(s) applied — ${refused.join("; ")}`);
            // The FIRST decided finding anchors the ledger row — a caller replaying this exact
            // batch gets back the same `done`/`refused` split, never a partial re-application.
            return { result: { done, refused }, result_table: "zz.eval_finding", result_id: done[0].id };
          },
        );

      let result: { done: (DecidedRow & { decided_by: string; note: string })[]; refused: string[] };
      if (outcome.replayed) {
        // A replay re-reads by id rather than trusting a cached response the ledger never stored.
        const rows = await Promise.all(decisions.map(async (d) => {
          const row = (await p.query<DecidedRow & { by: string | null; note: string | null }>(
            "select id::text as id, pattern, decision, decided_at::text as at, decided_by as by, decision_note as note from zz.eval_finding where id = $1::uuid",
            [d.finding_id])).rows[0];
          return row && row.decision !== "deferred"
            ? { id: row.id, pattern: row.pattern, decision: row.decision, at: row.at,
                decided_by: row.by ?? who, note: row.note ?? "" }
            : null;
        }));
        const done = rows.filter((r): r is DecidedRow & { decided_by: string; note: string } => r !== null);
        result = { done, refused: decisions.length - done.length > 0 ? ["some decisions from the original call could not be re-read"] : [] };
      } else {
        result = outcome.result;
      }

      logActivity(await userRoot(), null,
        { user: who, action: "finding_decide", decided: result.done.length, refused: result.refused.length, replayed: outcome.replayed });
      return json({
        decided: result.done.length, findings: result.done,
        refused: result.refused.length ? result.refused : undefined,
        next: result.done.length
          ? "These no longer count against the plugin's headroom. The next round will read the " +
            "remaining open ones and say what is still available to do."
          : "Nothing was decided.",
      });
    },
  );

  server.registerTool(
    "round_score",
    {
      description:
        "WHEN a round's marks and findings are in and the report needs its numbers. It " +
        "computes the TWO AXES from figures no model touched — effectiveness out of 10 with " +
        "the band it falls in, and headroom: the distance from 10, the count of named changes " +
        "still open on this plugin, and which of four states that puts it in. It records both " +
        "and RETURNS them, with the open changes enumerated so the count can be checked. It " +
        "also asks the typed service one thing the marks cannot answer — how strong this body " +
        "of evidence is. IT RECOMMENDS NOTHING: it used to choose `keep` / `keep-and-change` / " +
        "`retire`, and that question has one permanent answer, because a plugin somebody " +
        "installed on purpose is one they keep. The headroom state is what replaced it and it " +
        "reports the evidence rather than prescribing an action: `no change needed`, `change " +
        "identified`, `unexplained gap`, `not measured`. REFUSES an eval_id nothing minted, " +
        "the CONTROL run's eval_id, and an eval_id no control run names — a round whose ruler " +
        "was never tried against another plugin's work establishes nothing. Reports evidence " +
        "strength as ABSENT, without failing and without withholding the axes, when the " +
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

      // No control, no verdict. A score without a blind control establishes nothing: a ruler
      // that cannot tell this plugin's work from another plugin's produces marks that mean
      // nothing, and the gap is the only thing that says which case you are in.
      //
      // DELIBERATE: a refusal here rather than a ruler line. The figure is not in the profile
      // and the control runs after the pass that would read it, so such a line would be false at
      // the instant it is measured whatever the truth is.
      const ctl = (await p.query<{ id: string }>(
        "select id::text as id from zz.eval where controls = $1::uuid limit 1", [eval_id])).rows[0];
      if (!ctl) {
        return text(
          "REFUSED: no control run names this round, so there is no verdict to give. A control " +
          "marks ANOTHER plugin's work against this same ruler; the gap between the two is what " +
          "says whether the ruler can tell the right artifact from the wrong one. Without it " +
          "the marks are unfalsifiable — a ruler that scores everything 4 and a ruler that " +
          "works look identical. Run round_judge again with `control: true` for this version, " +
          "then call this. Rounds taken before controls were recorded cannot be recommended on " +
          "and have to be re-taken.");
      }

      // What this round established, read back rather than re-derived. Every figure is already
      // stored: the means the judge produced, the control it was tried against, the thresholds.
      // Re-deriving would let the recommendation rest on numbers the report never showed.
      const dims = (await p.query<{ dimension: string; kind: string; mean: string; n: string;
                                    confidence: string | null }>(`
        select d.name as dimension, d.kind, round(avg(s.score),2)::text as mean,
               count(*)::text as n, round(avg(s.confidence),2)::text as confidence
          from zz.eval_score s join zz.rubric_dimension d on d.id = s.dimension_id
         where s.eval_id = $1::uuid and not s.is_control
         group by d.name, d.kind, d.ordinal order by d.ordinal`, [eval_id])).rows;
      // This round's own control, named — not every round that shares a version and a ruler.
      // Pooling across `plugin_version_id + rubric_id` lets a round whose own control collapsed
      // read as discriminating because an earlier round's did.
      const control = (await p.query<{ real: string | null; ctl: string | null }>(`
        select round(avg(s.score) filter (where not s.is_control),2)::text as real,
               round(avg(s.score) filter (where s.is_control),2)::text as ctl
          from zz.eval_score s
          join zz.rubric_dimension d on d.id = s.dimension_id and d.kind <> 'quantitative'
         where s.eval_id in ($1::uuid, $2::uuid)`, [eval_id, ctl.id])).rows[0];
      // Every finding still open on this plugin, not just this round's: headroom counts named
      // changes, and a change named by an earlier round and never decided is one.
      //
      // `deferred` is the open state; the other two are closed. `applied` would charge the
      // plugin for work already done, and `rejected` is a change nobody intends to make. Neither
      // is a silent drop — `finding_decide` records who closed it and why.
      const findings = (await p.query<{ id: string; scope: string; pattern: string;
                                        change: string; round: string; open: boolean }>(`
        select f.id::text as id, f.scope, f.pattern, f.proposed_change as change,
               pv2.version as round, (f.decision = 'deferred') as open
          from zz.eval_finding f
          join zz.eval e2 on e2.id = f.eval_id
          join zz.plugin_version pv2 on pv2.id = e2.plugin_version_id
         where pv2.plugin_id = (select pv.plugin_id from zz.eval e
                                  join zz.plugin_version pv on pv.id = e.plugin_version_id
                                 where e.id = $1::uuid)
           and (f.eval_id = $1::uuid or f.decision = 'deferred')
         order by f.created_at`, [eval_id])).rows;
      const open = findings.filter((f) => f.open);

      const gap = control?.real && control?.ctl
        ? Math.round((Number(control.real) - Number(control.ctl)) * 100) / 100 : null;
      // The score goes into the state, so the enum is chosen knowing it. The word and the number
      // answer different questions and must not be derived independently, or a report can carry
      // "keep" beside a 4.2 with nothing saying which to believe.
      const qual = dims.filter((d) => d.kind === "qualitative");
      const quant = dims.filter((d) => d.kind === "quantitative");
      const qualMean = qual.length
        ? Math.round((qual.reduce((a, d) => a + Number(d.mean), 0) / qual.length) * 100) / 100
        : null;
      const metCount = quant.filter((d) => Number(d.mean) >= 5).length;
      const effective = effectiveness(qualMean, metCount, quant.length, gap);
      const room = headroom(effective.score, quant.length - metCount,
                            open.filter((f) => f.scope === "generic").length);

      const state = [
        `Plugin under evaluation: ${round.plugin} ${round.version}, marked against rubric ` +
        `version ${round.rubric} by judge ${round.judge}.`,
        effective.score === null
          ? `Effectiveness: NOT MEASURABLE. ${effective.basis}`
          : `Effectiveness: ${effective.score} out of 10 — "${effective.band}". ${effective.basis}.`,
        `Room to improve: ${room.state} — ${headroomNote(room)}.`,
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
        // The same set the score was computed from. A state naming only this round's findings
        // while headroom counted every open one would let `keep` be chosen against a plugin with
        // four changes waiting that were never shown.
        open.length
          ? `Changes still open on this plugin: ${open.length}, of which ` +
            `${open.filter((f) => f.round === round.version).length} were named by this round ` +
            `and the rest by earlier ones and never decided (` +
            open.map((f) => `${f.scope}, from ${f.round}: ${f.pattern}`).join(" | ").slice(0, 1200) + ")."
          : findings.length
            ? `This round recorded ${findings.length} finding(s) and every change named against ` +
              "this plugin has since been applied or rejected, so nothing is open."
            : "No findings were recorded against this round, and none are open from earlier ones.",
      ].join(" ");

      // Absence is an answer. A deployment with no key still produces a report — one that says
      // the typed judgement was not taken and why, which a reader can act on.
      if (!configured()) {
        return json({
          eval_id, plugin: round.plugin, version: round.version,
          effectiveness: effective, headroom: { ...room, note: headroomNote(room) },
          evidence_strength: null, absent: NOT_CONFIGURED,
          state_that_would_have_been_asked: state,
          next: "BOTH AXES ARE STILL GOOD — they are computed from figures no model touched, " +
                "and they are above. What is absent is only how strong the typed judge would " +
                "have called this body of evidence. Write the report, carry both axes, and say " +
                "in section 1 that evidence strength was not taken and why.",
        });
      }

      // No recommendation is asked for. Both axes are computed from figures no model touched, so
      // a choice between `keep`/`re-run`/`retire` adds nothing.
      //
      // What is asked is how strong the body of evidence is: a judgement about the round rather
      // than the plugin, not derivable from the marks.
      const questions: Record<string, ScoreQuestion> = {
        evidence_strength: {
          type: "score",
          instructions: "How strong is the body of evidence behind this verdict?",
          criteria: ["No usable evidence", "Thin — one source only", "Adequate", "Strong across two independent sources"],
        },
      };
      let strength;
      try {
        strength = (await ask(state, questions)).evidence_strength;
      } catch (err) {
        return text(String((err as Error).message));
      }

      // The number is stored, not only returned, so anything reading this table later sees a
      // measurement and not just a verb.
      //
      // COUPLED: judge-score.ts owns the arithmetic. Stored rather than recomputed by the
      // reader, because a second copy in the console's API would drift the first time a weight
      // changed. The band is not stored — it is `band(score)` over a column in the same row, so
      // storing it stores a cache. The rule lives in @zz/contracts; both services call it.
      await p.query(`
        update zz.eval set effectiveness = $2, headroom_points = $3,
                           headroom_named = $4, headroom_state = $5
         where id = $1::uuid`,
        [eval_id, effective.score, room.points, room.named_changes, room.state]);

      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "round_score", eval_id, plugin: round.plugin,
          version: round.version, effectiveness: effective.score, headroom: room.state });

      return json({
        eval_id, plugin: round.plugin, version: round.version,
        // Two axes and nothing else. They answer different questions — how well it performs, and
        // whether anything is left to do — and neither is derivable from the other.
        effectiveness: effective,
        headroom: { ...room, note: headroomNote(room) },
        // What the headroom is made of, with the handle needed to close each one — the rows the
        // count was computed from, including ones earlier rounds named and nobody has decided.
        open_changes: open.map((f) => ({
          finding_id: f.id, scope: f.scope, named_by_round: f.round,
          pattern: f.pattern, proposed_change: f.change,
          carried_over: f.round !== round.version,
        })),
        // The figure, its scale and how sure the judge was, all three as the adapter validated
        // them. A reply carrying none of that never reaches here — `ask` refuses it — so a null
        // here is the absence of a score rather than a score nobody could read.
        evidence_strength: strength && strength.readings.score !== null
          ? { score: strength.readings.score, legend: strength.readings.legend,
              confidence: strength.readings.confidence }
          : null,
        judge_on_trial_gap: gap,
        next: "Both axes are recorded. Section 1 of findings.md carries them verbatim — the " +
              "score with its band, and the headroom state with its count; the paragraphs " +
              "underneath are yours to write, from these numbers and from reading the " +
              "artifacts, never a different conclusion reached in prose.",
      });
    },
  );
}
