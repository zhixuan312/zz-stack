/**
 * The tools that write down what a person (or EVALUATE itself) decided: the findings an
 * `eval_run` concluded, and what became of each finding. Everything else in the plugin
 * evaluation reads.
 *
 * `round_score`, which computed a legacy round's two axes onto `zz.eval`, is gone with the
 * round writer it closed; `evaluation_score` (`evaluate.ts`) is what scores a run now, and
 * `round_scores` (`plugin-judge.ts`) still reads the historic rows.
 *
 * Task I-10 removed `ruler_record`, which used to live here — writing `zz.rubric*` for the
 * define stage, ahead of `ruler_affirm`. `protocol_record` (`protocol.ts`) is what writes a
 * plugin's measurement object now, into `zz.eval_protocol_version` and never `zz.rubric*`.
 *
 * Task I-13 replaces `finding_record`'s own shape: a finding now belongs to one `eval_run_id`
 * (migration 002's `zz.eval_finding.eval_run_id`, alongside the legacy `eval_id` a historic round
 * carries — see 002's own comment on zz.eval_finding for the dual-lifecycle shape), names its `kind`
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
          finding_id: z.string().describe("from finding_record"),
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
                : `${d.finding_id} names no finding. Ids come from finding_record.`);
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
}
