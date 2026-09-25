/**
 * `evaluator_qualify` (Task I-11, FR-16, AC-16.1, AC-17.1): runs a protocol's qualification
 * policy over one registered evaluator version and writes exactly one
 * `zz.eval_evaluator_qualification` row naming its state and the evidence behind it.
 *
 * The four evidence categories and the pure ladder that turns their counts into a state are
 * `qualify-evidence.ts` and `qualify-ladder.ts`; this file is the tool itself — resolving the
 * protocol's policy and the bound measure, gathering evidence, applying the ladder, and writing
 * the row through the FR-59 idempotency ledger, the same shape every mutator on this door uses.
 *
 * `subject_scope` is not a caller-supplied input: it is derived from the protocol's own plugin,
 * `{ plugin_id }`, the same way `protocol_affirm` derives a document path from an `initiative`
 * it is handed rather than asked to guess — see this file's own tool description for the same
 * disclosure made to a caller.
 *
 * DELIBERATE: the caller names the measure by `measure_key`, never an `evaluator_version_id`.
 * The key is what the define stage wrote into `protocol_body`; the evaluator version is minted
 * inside `protocol_record` and no tool returns it, so a contract that asked for it sent the agent
 * to read a table it has no door to. The measure resolves the evaluator version through the
 * protocol version the caller already names.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QualificationPolicy, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import {
  gatherCountedEvidence, gatherKnownAnswerEvidence, labelEvidence, mappingFor, parseLabelMappings,
  type KnownAnswers, type SnapshotRow,
} from "./qualify-evidence.js";
import { qualificationState, resolveThresholds, type LadderEvidence } from "./qualify-ladder.js";
import {
  decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome,
} from "./idempotency.js";
import { insertEvaluatorAnswer, type AskedEvaluatorAnswer } from "../semantic.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no evaluator can be qualified");
const MODEL_BACKED = new Set(["bounded_semantic", "generative_critic"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exported for `replay-derive.ts` (Task I-14): `replay_case_set_build` resolves the SAME
 *  protocol context this tool does before deciding whether `replay.source_kind` needs qualifying
 *  — one resolver, so the two callers can never read a protocol's policy differently. */
export interface ProtocolContext {
  pluginId: string; policy: QualificationPolicy | null; version: number; affirmed: boolean;
}

export async function resolveProtocol(p: pg.Pool, protocolVersionId: string): Promise<ProtocolContext | null> {
  if (!UUID_RE.test(protocolVersionId)) return null;
  const row = (await p.query<{ plugin_id: string; qualification_policy: unknown; version: number; affirmed: boolean }>(`
    select pr.plugin_id::text as plugin_id, pv.qualification_policy as qualification_policy,
           pv.version, pv.approved_document_path is not null as affirmed
      from zz.eval_protocol_version pv
      join zz.eval_protocol pr on pr.id = pv.protocol_id
     where pv.id = $1::uuid`, [protocolVersionId])).rows[0];
  if (!row) return null;
  const parsed = QualificationPolicy.safeParse(row.qualification_policy);
  return { pluginId: row.plugin_id, policy: parsed.success ? parsed.data : null, version: row.version, affirmed: row.affirmed };
}

/** FR-6's gate, read where it matters: `protocol_record` writes every version with
 *  `approved_document_path` null, and only `protocol_affirm` sets it, once a person approved the
 *  `protocol.md` quoting its digest. Nothing is qualified, replay-derived or scored against a
 *  version that never got there. No exemption for a bootstrap protocol (`zz-core.v1`): it is
 *  recorded through `protocol_record` like any other body and affirmed the same way —
 *  `scoring.establishment.bootstrap` only caps what its score may claim. */
export function unaffirmedRefusal(protocolVersionId: string, protocol: ProtocolContext): string | null {
  if (protocol.affirmed) return null;
  return `ERROR: protocol_version_id ${protocolVersionId} (version ${protocol.version}) has not been affirmed — ` +
    "write protocol.md quoting its content_digest, get it approved, and call protocol_affirm first; " +
    "nothing is qualified or scored against a protocol nobody agreed";
}

/** Exported for the same reason as `resolveProtocol` above. */
export async function resolveEvaluator(p: pg.Pool, evaluatorVersionId: string): Promise<string | null> {
  if (!UUID_RE.test(evaluatorVersionId)) return null;
  const row = (await p.query<{ stable_key: string }>(`
    select e.stable_key as stable_key
      from zz.eval_evaluator_version v join zz.eval_evaluator e on e.id = v.evaluator_id
     where v.id = $1::uuid`, [evaluatorVersionId])).rows[0];
  return row ? row.stable_key : null;
}

/** A `measure_key` inside one protocol version, resolved to its row — or the refusal, by name.
 *  `protocol_record` refuses a body that repeats a key anywhere in it (`duplicateMeasureKeyRefusal`),
 *  but migration 001 carries no such constraint and a version recorded before that refusal may
 *  still share one across two dimensions — refused here naming both rather than resolved to
 *  whichever row came first. Exported for `finding_record` (plugin-record.ts), which cites a
 *  measure by the same key: one resolver, so the two can never read a key differently. */
export async function measureByKey(
  p: pg.Pool, protocolVersionId: string, measureKey: string,
): Promise<{ id: string; evaluator_type: string; evaluator_version_id: string | null } | { error: string }> {
  const rows = (await p.query<{ id: string; key: string; dimension: string; evaluator_type: string; evaluator_version_id: string | null }>(`
    select m.id::text as id, m.key, d.key as dimension, m.evaluator_type,
           m.evaluator_version_id::text as evaluator_version_id
      from zz.eval_measure m join zz.eval_dimension d on d.id = m.dimension_id
     where d.protocol_version_id = $1::uuid
     order by d.key, m.key`, [protocolVersionId])).rows;
  const named = rows.filter((r) => r.key === measureKey);
  if (!named.length) {
    return { error: `ERROR: protocol version ${protocolVersionId} has no measure "${measureKey}" — ` +
      `its measures are ${rows.length ? rows.map((r) => r.key).join(", ") : "none"}` };
  }
  if (named.length > 1) {
    return { error: `ERROR: measure "${measureKey}" is in more than one dimension of protocol version ` +
      `${protocolVersionId} (${named.map((r) => r.dimension).join(", ")}) — record a new protocol version ` +
      "that gives each a distinct key" };
  }
  const [{ id, evaluator_type, evaluator_version_id }] = named;
  return { id, evaluator_type, evaluator_version_id };
}

interface MeasureBinding {
  measureId: string;
  vocabulary: { positive: string; zero: string } | null;
}

/** The measure the caller already resolved, read for its anchor vocabulary. `null` — an evaluator
 *  no protocol measure defers to — is the `no_anchors` path, never a refusal of the call itself
 *  (the contract wants that reported as an evidence-shaped answer, not an error).
 *
 *  DELIBERATE: by id, never re-found by evaluator version. Two measures may defer to the same
 *  evaluator version (`registerEvaluator` is idempotent by content), and a `limit 1` lookup would
 *  read whichever one's vocabulary came first rather than the measure the caller named. */
async function resolveMeasure(p: pg.Pool, measureId: string | null): Promise<MeasureBinding | null> {
  if (!measureId) return null;
  const row = (await p.query<{ id: string; definition: unknown }>(
    "select id::text as id, definition from zz.eval_measure where id = $1::uuid", [measureId])).rows[0];
  if (!row) return null;
  const def = (row.definition ?? {}) as Record<string, unknown>;
  const q = def.qualification as Record<string, unknown> | undefined;
  const positive = typeof q?.positive === "string" ? q.positive : null;
  const zero = typeof q?.zero === "string" ? q.zero : null;
  return { measureId: row.id, vocabulary: positive !== null && zero !== null ? { positive, zero } : null };
}

async function latestSnapshot(p: pg.Pool, pluginId: string, exclude: boolean): Promise<SnapshotRow | null> {
  const row = (await p.query<{ id: string; usable_run_count: number; total_run_count: number; coverage: SnapshotRow["coverage"] }>(`
    select os.id::text as id, os.usable_run_count, os.total_run_count, os.coverage
      from zz.eval_observation_snapshot os
      join zz.eval_subject_version sv on sv.id = os.subject_version_id
     where sv.plugin_id ${exclude ? "<>" : "="} $1::uuid
     order by os.created_at desc limit 1`, [pluginId])).rows[0];
  return row ?? null;
}

interface QualifyResult {
  qualification_id: string;
  state: string;
  evidence: {
    anchors: { passed: number; total: number };
    planted_faults: { killed: number; total: number };
    controls: { failed_as_expected: number; total: number };
    stability: { agreeing: number; total: number };
    labels: { n: number; tpr: number; tnr: number } | null;
    reason: string | null;
  };
}

function respond(counted: LadderEvidence, state: string, reason: string | null, qualificationId: string): QualifyResult {
  return {
    qualification_id: qualificationId, state,
    evidence: {
      anchors: { passed: counted.anchors.passed, total: counted.anchors.total },
      planted_faults: { killed: counted.planted_faults.passed, total: counted.planted_faults.total },
      controls: { failed_as_expected: counted.controls.passed, total: counted.controls.total },
      stability: { agreeing: counted.stability.passed, total: counted.stability.total },
      labels: counted.labels, reason,
    },
  };
}

/** Anything `recordQualification` writes through: a transaction's own client (the ledger
 *  transaction in `evaluator_qualify`, or the case-set build's in `replay-cases.ts`). Mirrors
 *  `idempotency.ts`'s own `Queryable` — an explicit generic signature, not
 *  `Pick<pg.Pool, "query">`, which TypeScript infers as a non-callable union over `Pool`'s
 *  overloads. */
interface Writer {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** One qualification run, decided and not yet written: the ladder's state, the evidence behind
 *  it, and every evaluator answer asked on the way, in ask order. */
export interface GatheredQualification {
  readonly protocolVersionId: string;
  readonly evaluatorVersionId: string;
  readonly pluginId: string;
  readonly state: string;
  readonly reason: string | null;
  readonly evidence: LadderEvidence;
  readonly asked: readonly AskedEvaluatorAnswer[];
}

/** The qualification run itself (FR-16), split in two so no model call ever runs inside a
 *  transaction: this half reads on the pool and asks every question (anchors, faults, controls,
 *  stability — up to nine calls of up to ~100s each) and writes nothing; `recordQualification`
 *  writes the answers and the row through the caller's transaction client. Two callers, the same
 *  split: `evaluator_qualify` below, and `replay-derive.ts`'s `resolveQualification` (FR-60 rule
 *  1's "runs `evaluator_qualify` for it first when no such qualification exists"), whose answers
 *  `replay_case_set_build` records inside its own ledger transaction. */
export async function gatherQualification(
  p: pg.Pool, protocolVersionId: string, evaluatorVersionId: string, measureId: string | null,
  protocol: ProtocolContext, stableKey: string, principal: string, known?: KnownAnswers,
): Promise<GatheredQualification> {
  const measure = await resolveMeasure(p, measureId);
  const { thresholds } = resolveThresholds(protocol.policy?.thresholds);

  const snapshot = measure ? await latestSnapshot(p, protocol.pluginId, false) : null;
  const foreignSnapshot = measure && snapshot ? await latestSnapshot(p, protocol.pluginId, true) : null;

  // A platform-owned evaluator no measure defers to has no snapshot fact to anchor on; its own
  // known answers stand in, or it could never climb past `no_anchors`.
  const { counts, asked } = !measure && known
    ? await gatherKnownAnswerEvidence({ evaluatorVersionId, principal, known })
    : await gatherCountedEvidence({
      evaluatorVersionId, principal, snapshot, foreignSnapshot,
      vocabulary: measure?.vocabulary ?? null,
    });
  const mappings = parseLabelMappings(protocol.policy?.labelMappings ?? []);
  const labels = measure
    ? await labelEvidence(p, measure.measureId, evaluatorVersionId, mappingFor(mappings, stableKey))
    : null;

  const evidence: LadderEvidence = { ...counts, labels };
  const { state, reason } = qualificationState(evidence, thresholds);
  return { protocolVersionId, evaluatorVersionId, pluginId: protocol.pluginId, state, reason, evidence, asked };
}

/** The write half: every asked answer's `zz.assessment` row, then the one
 *  `zz.eval_evaluator_qualification` row — all through `writer`, so they commit or roll back
 *  together with the caller's ledger row. Database writes only; never asks. */
export async function recordQualification(writer: Writer, g: GatheredQualification): Promise<QualifyResult> {
  for (const answer of g.asked) await insertEvaluatorAnswer(writer, answer);
  const row = (await writer.query<{ id: string }>(`
    insert into zz.eval_evaluator_qualification
      (evaluator_version_id, protocol_version_id, subject_scope, state, evidence, qualified_at)
    values ($1::uuid, $2::uuid, $3::jsonb, $4, $5::jsonb, now())
    returning id::text as id`,
    [g.evaluatorVersionId, g.protocolVersionId, JSON.stringify({ plugin_id: g.pluginId }),
     g.state, JSON.stringify({ ...g.evidence, reason: g.reason })])).rows[0];
  if (!row) throw new Error("insert into zz.eval_evaluator_qualification produced no row");

  return respond(g.evidence, g.state, g.reason, row.id);
}

export function registerEvaluatorQualifyTools(server: McpServer): void {
  server.registerTool(
    "evaluator_qualify",
    {
      description:
        "WHEN a model-backed measure's evaluator needs its qualification state established " +
        "(or re-established) against one protocol version, before its answers may back a score. " +
        "Name the measure by the measure_key you wrote into protocol_body; the evaluator version " +
        "it defers to is resolved from that protocol version, never passed in. Runs the " +
        "protocol's own QualificationPolicy over four evidence categories — anchors " +
        "(known answers derived from the plugin's own OBSERVE snapshot facts), planted faults " +
        "(the same facts, sign-flipped, killed when the evaluator's answer flips with them), " +
        "controls (the same facts read off another plugin's own real snapshot, never a " +
        "mutation) and stability (one anchor asked three times) — plus labels, ONLY where the " +
        "protocol's qualification.labelMappings names this evaluator's stable_key. RETURNS " +
        "{ measure_key, evaluator_version_id, qualification_id, state, evidence: { anchors: " +
        "{passed, total}, planted_faults: {killed, total}, controls: {failed_as_expected, total}, " +
        "stability: {agreeing, total}, labels: {n, tpr, tnr} | null } }, writing exactly one " +
        "zz.eval_evaluator_qualification row scoped to { plugin_id } (derived from the protocol). " +
        "REFUSES an unknown protocol_version_id; one protocol_affirm has not bound (not yet approved); " +
        "a measure_key this protocol version does not " +
        "have (naming the keys it does have); a key two dimensions share; and a " +
        "deterministic/outcome/human measure, which is not qualified. NEVER refuses on thin " +
        "evidence — no anchor can be built (the measure's own definition.qualification names no " +
        "{positive, zero} vocabulary, or the plugin has no OBSERVE snapshot yet) answers " +
        "state=unqualified, reason=no_anchors instead. A mutator: writes through the FR-59 " +
        "idempotency ledger, so a retried call with the same idempotency_key replays the same " +
        "row rather than re-asking any model.",
      inputSchema: {
        protocol_version_id: z.string(),
        measure_key: z.string().min(1).describe("The measure's key as written in protocol_body."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ protocol_version_id, measure_key, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const protocol = await resolveProtocol(p, protocol_version_id);
      if (!protocol) return text("ERROR: unknown protocol_version_id");
      const unaffirmed = unaffirmedRefusal(protocol_version_id, protocol);
      if (unaffirmed) return text(unaffirmed);
      const measure = await measureByKey(p, protocol_version_id, measure_key);
      if ("error" in measure) return text(measure.error);
      // By type, not by a null evaluator: a deterministic/outcome measure may still name one
      // (001), and a qualification written for it is one `qualificationMet` never reads.
      const evaluator_version_id = measure.evaluator_version_id;
      if (!MODEL_BACKED.has(measure.evaluator_type) || !evaluator_version_id) {
        return text(`ERROR: measure "${measure_key}" is ${measure.evaluator_type} — only a ` +
          "bounded_semantic/generative_critic measure's evaluator is qualified");
      }
      const stableKey = await resolveEvaluator(p, evaluator_version_id);
      if (!stableKey) return text(`ERROR: measure "${measure_key}" names evaluator version ${evaluator_version_id}, which is not registered`);

      const principal = parseCaller(requestHeaders()).email;

      // Every model call happens before the transaction: a retry is ruled out first (so it never
      // re-asks), then the ladder asks on the pool, then the transaction only writes.
      const args = { protocol_version_id, measure_key };
      const prior = await decideBeforeWork(principal, "evaluator_qualify", idempotency_key, args);
      let outcome: IdempotencyOutcome<QualifyResult>;
      if (prior.replayed) {
        outcome = prior;
      } else {
        const gathered = await gatherQualification(
          p, protocol_version_id, evaluator_version_id, measure.id, protocol, stableKey, principal);
        outcome = await withIdempotency(
          principal, "evaluator_qualify", idempotency_key, args,
          async (client): Promise<MutatorOutcome<QualifyResult>> => {
            const result = await recordQualification(client, gathered);
            return { result, result_table: "zz.eval_evaluator_qualification", result_id: result.qualification_id };
          },
        );
      }

      let result: QualifyResult;
      if (outcome.replayed) {
        const row = (await p.query<{ state: string; evidence: QualifyResult["evidence"] }>(
          "select state, evidence from zz.eval_evaluator_qualification where id = $1::uuid", [outcome.result_id])).rows[0];
        if (!row) throw new Refusal("ERROR: idempotency ledger points at a qualification this call cannot read back");
        result = { qualification_id: outcome.result_id, state: row.state, evidence: row.evidence };
      } else {
        result = outcome.result;
      }

      logActivity(await userRoot(), null, {
        user: principal, action: "evaluator_qualify", protocol_version_id, measure_key, evaluator_version_id,
        state: result.state, replayed: outcome.replayed,
      });
      return json({ measure_key, evaluator_version_id, ...result });
    },
  );
}
