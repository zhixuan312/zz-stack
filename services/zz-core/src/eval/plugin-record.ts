/**
 * The tools that write down what a person (or EVALUATE itself) decided: the findings an
 * `eval_run` concluded, and what became of each finding. Everything else in the plugin
 * evaluation reads.
 *
 * `round_score`, which computed a legacy round's two axes onto `zz.eval`, is gone with the
 * round writer it closed; `evaluation_score` (`evaluate.ts`) is what scores a run now. The legacy
 * rounds are in the phase-3 migration's archive, and no tool reads them.
 *
 * Task I-10 removed `ruler_record`, which used to live here — writing `zz.rubric*` for the
 * define stage, ahead of `ruler_affirm`. `protocol_record` (`protocol.ts`) is what writes a
 * plugin's measurement object now, into `zz.eval_protocol_version` and never `zz.rubric*`.
 *
 * Task I-13 replaced `finding_record`'s own shape: a finding belongs to one `eval_run_id`, names
 * its `kind` (strength/defect/unknown) and REQUIRES `owner_kind` at recording time rather than
 * leaving ownership to a later pass. This is a breaking change: the OLD
 * `finding_record(eval_id, findings: [...])` shape this file used to accept is gone, not carried
 * forward under an alias — no caller of the legacy round pipeline ever wrote a new-pipeline
 * finding, and the reverse was never true either.
 *
 * Task I-31 closes the other half of that, and `zz.eval_finding` now holds ONE lifecycle. The
 * legacy lifecycle's five columns — `eval_id`, `scope`, `docs_affected`, `proposed_change` and
 * `resulted_in_skill_version_id` — had no writer since I-13 and their eleven rows went out with
 * the archived rounds in Phase 3, so the improve tables' migration drops them and no statement
 * here reads or writes one. The table's own constraints say what the surviving lifecycle is:
 * `decision` is null exactly when `kind='strength'` (a strength is what is working, terminal at
 * insert), `superseded_by` points at a rejected finding of the same run, and `owner_ref` stays
 * null for a plugin-owned finding because it always equals the subject's own plugin and is
 * derivable through the run. Both are refused by name below rather than left to the constraint.
 *
 * `finding_decide` writes through the FR-59 idempotency ledger like every other mutator on this
 * door — the plan's own words, "finding_decide joins the idempotency ledger" — and closes a
 * finding by `id` through `decideFinding` (below), the ONE deciding write on this table: a second
 * private writer is exactly what left the finding-to-release provenance unrecorded for
 * twenty-one releases, so `release_record` calls the same function by name.
 *
 * It does not approve. A defect or unknown lands `deferred` — open work, closed only by
 * `finding_decide` — and a strength lands terminal, with no decision at all. The platform holds
 * what was decided.
 *
 * A finding is never edited. A wrong one is corrected by recording its replacement with
 * `supersedes`: in one transaction the new finding lands and the old one is closed — rejected,
 * its note naming the replacement, `superseded_by` pointing at it — so findings.md shows only the
 * current one, with the correction said, and no reader counts the wrong one as open.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EVAL_STATE_ENUMS, parseCaller } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { writeFindingsDoc } from "./findings-doc.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { measureByKey } from "./qualify.js";
import { platformEvent } from "../indexing.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing can be recorded");

/** One finding, as a decision left it — what `finding_decide` reports back and what a release's
 *  own deciding write hands its caller. */
export interface DecidedFinding {
  readonly id: string;
  readonly pattern: string;
  readonly decision: "applied" | "rejected";
  readonly at: string;
  readonly decided_by: string;
  readonly note: string;
}

/** What one decision attempt answered: the row it closed, or the sentence saying why it closed
 *  nothing. A refusal is a sentence rather than a code because both callers put it in front of a
 *  person — `finding_decide` in its `refused` list, `release_record` wherever it reports what the
 *  release did not close. */
export type DecisionOutcome = { readonly decided: DecidedFinding } | { readonly refused: string };

/** Why a decision closed nothing, said by name. Three answers, because a caller needs to tell
 *  them apart: an id nothing minted is a caller working from the wrong run, a strength is not open
 *  work at all and has no decision to record, and an already-decided finding is one about to be
 *  reopened. */
function decisionRefusal(
  findingId: string,
  was: { kind: string; decision: string | null; superseded_by: string | null;
         by: string | null; note: string | null } | undefined,
): string {
  if (!was) return `${findingId} names no finding. Ids come from finding_record.`;
  if (was.kind === "strength") {
    return `${findingId} is a strength — what is working, not open work — and a strength is ` +
      "terminal at insert: its decision is null by construction, so there is none to record. " +
      "Record what the next round found instead.";
  }
  if (was.superseded_by) {
    return `${findingId} was superseded by ${was.superseded_by} — a superseded finding is closed ` +
      "for every reader. Correct the finding that replaced it instead.";
  }
  return `${findingId} was already ${was.decision}${was.by ? ` by ${was.by}` : ""}` +
    `${was.note ? ` — "${was.note}"` : ""}. Reopening a decided finding is not something ` +
    "this tool does: record what the next round found instead.";
}

/** The ONE deciding write on `zz.eval_finding` (AC-7.1). `finding_decide` and `release_record`
 *  both call this by name; nothing else in the tree closes a finding, because a second private
 *  writer is how the finding-to-release provenance went unrecorded for twenty-one releases.
 *
 *  The update is guarded in its own `where` clause rather than read-then-written: reading the row
 *  first would let two callers deciding the same finding both see `deferred` and both write.
 *  `returning` gives back the row this call closed; no row means it closed nothing, and the read
 *  below says which of the three reasons it was.
 *
 *  `runner` is the pool or a transaction's own client: a caller already inside `withIdempotency`
 *  passes the client, so the decision and its ledger row are one commit.
 *
 *  `by` is the email address the door resolved, and `decided_by` is a foreign key to
 *  `zz.principal` — so the address becomes the principal row it names before anything is written,
 *  the same turn `idempotency.ts` makes for the ledger's key. An address no principal answers to
 *  is refused here rather than written as a null decider: `release_record` records who released
 *  (that is what its own `releaseActorRefusal` establishes), and a finding closed by nobody in
 *  particular is the provenance gap this function exists to close. `decided_by` comes back as the
 *  address, not the id — what a caller of this door has, and what every response already says. */
export async function decideFinding(
  runner: Pick<pg.PoolClient, "query">,
  findingId: string,
  decision: "applied" | "rejected",
  note: string,
  by: string,
): Promise<DecisionOutcome> {
  const actor = (await runner.query<{ id: string }>(
    "select id::text as id from zz.principal where lower(email) = lower($1)", [by])).rows[0];
  if (!actor) {
    return { refused: `"${by}" resolves to no principal, so a decision it made cannot be recorded — decided_by names a principal row, not the address the call came from.` };
  }
  const row = (await runner.query<{ id: string; pattern: string; decision: "applied" | "rejected"; at: string }>(`
    update zz.eval_finding
       set decision = $2, decision_note = $3, decided_by = $4::uuid, decided_at = now()
     where id = $1::uuid and decision = 'deferred'
    returning id::text as id, pattern, decision, decided_at::text as at`,
    [findingId, decision, note, actor.id])).rows[0];
  if (row) return { decided: { ...row, decided_by: by, note } };
  const was = (await runner.query<{
    kind: string; decision: string | null; superseded_by: string | null;
    by: string | null; note: string | null;
  }>(`
    select f.kind, f.decision, f.superseded_by::text as superseded_by, p.email as by,
           f.decision_note as note
      from zz.eval_finding f
      left join zz.principal p on p.id = f.decided_by
     where f.id = $1::uuid`, [findingId])).rows[0];
  return { refused: decisionRefusal(findingId, was) };
}

export function registerPluginRecordTools(server: McpServer): void {
  server.registerTool(
    "finding_record",
    {
      annotations: WRITES,
      description:
        "WHEN evaluation_score (or a round's report stage, for a strength/defect/unknown found " +
        "against an eval_run) has decided what the pattern is. It records ONE finding against " +
        "eval_run_id and RETURNS it as stored — DEFERRED, the open state finding_decide closes, " +
        "unless `kind` is strength: a strength is what is working rather than open work, so it is " +
        "terminal at insert and carries no decision. `kind` is strength " +
        "(what is working), defect (what is wrong) or unknown (evidence does not say which). " +
        "`owner_kind` is REQUIRED: a finding on somebody else's plugin/dependency/platform/ " +
        "environment/user_input carries no expected_effect — assess and stop. Pass `initiative` " +
        "to regenerate that initiative's findings.md from this eval_run's current score and " +
        "every finding recorded against it so far — omit it to record without touching the " +
        "document. Cite the measure a finding is evidence for by its measure_key, as written in " +
        "the protocol this eval_run was scored against. REFUSES an eval_run_id nothing minted, a " +
        "call missing owner_kind, a `measure_key` that protocol version does not have (naming " +
        "the keys it does), and an `owner_ref` on a plugin-owned finding — that owner is the " +
        "subject's own plugin, reached through the run. To correct a finding already recorded, " +
        "record the corrected one with " +
        "`supersedes: <its id>` — the old one is closed as superseded in the same write and " +
        "findings.md renders only the current one, noting the correction; REFUSES superseding a " +
        "finding of another eval_run, a strength, or one already decided or superseded. A " +
        "mutator: writes through the idempotency ledger.",
      inputSchema: {
        eval_run_id: z.string(),
        finding: z.object({
          kind: z.enum(EVAL_STATE_ENUMS.findingKind),
          pattern: z.string().describe("what this run found, in one sentence"),
          owner_kind: z.enum(EVAL_STATE_ENUMS.ownerKind),
          owner_ref: z.string().optional().describe(
            "which dependency/platform/environment/user_input, when owner_kind names one — omit " +
            "it for a plugin-owned finding, whose owner is the subject's own plugin and is " +
            "reached through the run"),
          measure_key: z.string().optional()
            .describe("the key of the measure this finding is evidence for, if one — resolved through this eval_run's own protocol version"),
          evidence_refs: z.array(z.string()).default([]),
          expected_effect: z.record(z.string(), z.unknown()).optional()
            .describe("what changing this is expected to move — omit when owner_kind is not 'plugin'"),
        }),
        supersedes: z.string().optional()
          .describe("the id of an earlier, still-deferred finding of this eval_run that this one corrects"),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe("regenerate <initiative>/findings.md after recording"),
      },
    },
    async ({ eval_run_id, finding, supersedes, idempotency_key, initiative }) => {
      const p = db();
      if (!p) return noDb();
      const run = (await p.query<{ id: string; protocol_version_id: string }>(
        "select id::text as id, protocol_version_id::text as protocol_version_id from zz.eval_run where id = $1::uuid",
        [eval_run_id])).rows[0];
      if (!run) return text(`ERROR: no eval_run ${eval_run_id}`);
      // Resolved before the ledger, so an unknown key refuses by name and anchors no ledger row.
      let measureId: string | null = null;
      if (finding.measure_key !== undefined) {
        const measure = await measureByKey(p, run.protocol_version_id, finding.measure_key);
        if ("error" in measure) return text(measure.error);
        measureId = measure.id;
      }
      // Checked before the ledger too, so a caller the table would refuse anchors nothing. A
      // plugin-owned finding's owner IS the subject's own plugin (`owner_ref` can only repeat what
      // the run already carries), so the column is required null — `check ((owner_kind <> 'plugin')
      // or (owner_ref is null))` is the backstop and this is the answer a caller can act on.
      if (finding.owner_kind === "plugin" && finding.owner_ref != null) {
        return text(
          `ERROR: owner_ref is not a plugin-owned finding's to carry (${finding.owner_ref}). ` +
          "owner_kind='plugin' means the subject's own plugin, which is reached through " +
          `eval_run ${eval_run_id}, so the column stays null — drop owner_ref, or name the ` +
          "owner_kind the finding really has.");
      }
      // Checked before the ledger too, so a correction aimed at the wrong finding anchors nothing.
      if (supersedes !== undefined) {
        const old = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supersedes)
          ? (await p.query<{ kind: string; eval_run_id: string | null; decision: string | null; superseded_by: string | null }>(
              "select kind, eval_run_id::text as eval_run_id, decision, superseded_by::text as superseded_by " +
              "from zz.eval_finding where id = $1::uuid", [supersedes])).rows[0]
          : undefined;
        if (!old) return text(`ERROR: supersedes names no finding (${supersedes}) — ids come from finding_record`);
        if (old.eval_run_id !== eval_run_id) {
          return text(`ERROR: finding ${supersedes} belongs to eval_run ${old.eval_run_id ?? "(a legacy round)"}, not ${eval_run_id} — a correction stays in its own run`);
        }
        // A strength is terminal at insert — decision null by construction — so it can never be the
        // superseded side of a correction: `superseded_by` is constrained to a rejected finding.
        if (old.kind === "strength") {
          return text(`ERROR: finding ${supersedes} is a strength — what is working, not open work — and a strength is terminal at insert, so it cannot be superseded. Correct a deferred defect or unknown instead.`);
        }
        if (old.superseded_by) return text(`ERROR: finding ${supersedes} was already superseded by ${old.superseded_by} — correct that one instead`);
        if (old.decision !== "deferred") {
          return text(`ERROR: finding ${supersedes} is already ${old.decision} — a decided finding stands; record what the next round found instead`);
        }
      }

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ id: string; kind: string; pattern: string }> = await withIdempotency(
        principal, "finding_record", idempotency_key, { eval_run_id, finding, supersedes },
        async (client): Promise<MutatorOutcome<{ id: string; kind: string; pattern: string }>> => {
          // A strength is terminal at insert — what is working is not open work — so its decision
          // lands null. Every other kind starts `deferred`, the open state finding_decide closes.
          const decision = finding.kind === "strength" ? null : "deferred";
          const row = (await client.query<{ id: string }>(`
            insert into zz.eval_finding
              (eval_run_id, kind, pattern, owner_kind, owner_ref, measure_id, evidence_refs,
               expected_effect, decision)
            values ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb, $9::text)
            returning id::text as id`,
            [eval_run_id, finding.kind, finding.pattern, finding.owner_kind, finding.owner_ref ?? null,
             measureId, JSON.stringify(finding.evidence_refs ?? []),
             finding.expected_effect ? JSON.stringify(finding.expected_effect) : null,
             decision])).rows[0];
          if (!row) throw new Error("insert into zz.eval_finding produced no row");
          if (supersedes !== undefined) {
            // Guarded in the where clause: a finding decided or superseded since the check above
            // refuses here, and the insert rolls back with it. `decided_by` is a principal id, so
            // the address this call resolved to is turned into the row it names — the same turn
            // `decideFinding` makes, and an address no principal answers to leaves it null, which
            // the ledger insert below refuses the whole transaction for anyway.
            const closed = await client.query(`
              update zz.eval_finding
                 set superseded_by = $2::uuid, decision = 'rejected', decided_at = now(),
                     decided_by = (select p.id from zz.principal p where lower(p.email) = lower($3)),
                     decision_note = $4
               where id = $1::uuid and decision = 'deferred' and superseded_by is null`,
              [supersedes, row.id, principal, `superseded by ${row.id}, which corrects it`]);
            if (closed.rowCount !== 1) throw new Refusal(`ERROR: finding ${supersedes} was decided or superseded while this call ran — nothing was recorded`);
          }
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

      platformEvent({
        actor: principal, kind: "finding_record", initiative, eval_run_id, finding_id: result.id, replayed: outcome.replayed,
      });
      return json({
        eval_run_id, finding: result, ...(supersedes !== undefined ? { superseded: supersedes } : {}),
        findings_md: doc === undefined ? undefined : typeof doc === "string" ? { refused: doc } : doc,
        next: result.kind === "strength"
          ? "A strength is recorded as what is working. It is not open work and IMPROVE never reads it."
          : "This finding is DEFERRED. It stays open, counting against this plugin's headroom, " +
            "until finding_decide records that somebody applied or rejected it.",
      });
    },
  );

  server.registerTool(
    "finding_decide",
    {
      annotations: WRITES,
      description:
        "WHEN somebody who owns the finding has applied the change it named, or has decided not " +
        "to. It closes those findings of an `eval_run` — a strength is never one of them — and " +
        "RETURNS each as it now stands, with who decided and when. This is the act " +
        "finding_record's own description promises: a defect or unknown " +
        "lands `deferred` and stays there until this is called. REFUSES an id nothing minted, a " +
        "finding already decided, a strength (terminal at insert, with no decision to record), " +
        "and `deferred` as a decision — deferring is where a finding starts, so choosing it here " +
        "would be a decision that changes nothing while looking like one that did. A note is " +
        "required for both real decisions, because `applied` with no change named and `rejected` " +
        "with no reason are the two ways this ledger stops being readable. A mutator: writes " +
        "through the idempotency ledger.",
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

      const outcome: IdempotencyOutcome<{ done: DecidedFinding[]; refused: string[] }> =
        await withIdempotency(
          who, "finding_decide", idempotency_key, { decisions },
          async (client): Promise<MutatorOutcome<{ done: DecidedFinding[]; refused: string[] }>> => {
            const done: DecidedFinding[] = [];
            const refused: string[] = [];
            for (const d of decisions) {
              // The one deciding write on this table, shared with release_record: guarded in its
              // own where clause, so two callers deciding the same finding cannot both write, and
              // it says by name which of the three reasons closed nothing when it closed nothing.
              const decided = await decideFinding(client, d.finding_id, d.decision, d.note.trim(), who);
              if ("decided" in decided) done.push(decided.decided);
              else refused.push(decided.refused);
            }
            if (!done.length) throw new Refusal(`REFUSED: none of the ${decisions.length} decision(s) applied — ${refused.join("; ")}`);
            // The FIRST decided finding anchors the ledger row — a caller replaying this exact
            // batch gets back the same `done`/`refused` split, never a partial re-application.
            return { result: { done, refused }, result_table: "zz.eval_finding", result_id: done[0].id };
          },
        );

      let result: { done: DecidedFinding[]; refused: string[] };
      if (outcome.replayed) {
        // A replay re-reads by id rather than trusting a cached response the ledger never stored.
        const rows = await Promise.all(decisions.map(async (d): Promise<DecidedFinding | null> => {
          const row = (await p.query<{
            id: string; pattern: string; decision: string | null; at: string;
            by: string | null; note: string | null;
          }>(`
            select f.id::text as id, f.pattern, f.decision, f.decided_at::text as at,
                   p.email as by, f.decision_note as note
              from zz.eval_finding f
              left join zz.principal p on p.id = f.decided_by
             where f.id = $1::uuid`, [d.finding_id])).rows[0];
          // `applied`/`rejected` only: a null decision is a strength, which this tool never closed.
          return row && (row.decision === "applied" || row.decision === "rejected")
            ? { id: row.id, pattern: row.pattern, decision: row.decision, at: row.at,
                decided_by: row.by ?? who, note: row.note ?? "" }
            : null;
        }));
        const done = rows.filter((r): r is DecidedFinding => r !== null);
        result = { done, refused: decisions.length - done.length > 0 ? ["some decisions from the original call could not be re-read"] : [] };
      } else {
        result = outcome.result;
      }

      platformEvent({ actor: who, kind: "finding_decide", decided: result.done.length, refused: result.refused.length, replayed: outcome.replayed });
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
