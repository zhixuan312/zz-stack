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
 * `subject_scope` is not a caller-supplied input (the plan header's own signature carries only
 * `protocol_version_id`, `evaluator_version_id` and `idempotency_key`): it is derived from the
 * protocol's own plugin, `{ plugin_id }`, the same way `protocol_affirm` derives a document path
 * from an `initiative` it is handed rather than asked to guess — see this file's own tool
 * description for the same disclosure made to a caller.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QualificationPolicy, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import {
  gatherCountedEvidence, labelEvidence, mappingFor, parseLabelMappings, type SnapshotRow,
} from "./qualify-evidence.js";
import { qualificationState, resolveThresholds, type LadderEvidence } from "./qualify-ladder.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no evaluator can be qualified");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exported for `replay-derive.ts` (Task I-14): `replay_case_set_build` resolves the SAME
 *  protocol context this tool does before deciding whether `replay.source_kind` needs qualifying
 *  — one resolver, so the two callers can never read a protocol's policy differently. */
export interface ProtocolContext { pluginId: string; policy: QualificationPolicy | null }

export async function resolveProtocol(p: pg.Pool, protocolVersionId: string): Promise<ProtocolContext | null> {
  if (!UUID_RE.test(protocolVersionId)) return null;
  const row = (await p.query<{ plugin_id: string; qualification_policy: unknown }>(`
    select pr.plugin_id::text as plugin_id, pv.qualification_policy as qualification_policy
      from zz.eval_protocol_version pv
      join zz.eval_protocol pr on pr.id = pv.protocol_id
     where pv.id = $1::uuid`, [protocolVersionId])).rows[0];
  if (!row) return null;
  const parsed = QualificationPolicy.safeParse(row.qualification_policy);
  return { pluginId: row.plugin_id, policy: parsed.success ? parsed.data : null };
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

interface MeasureBinding {
  measureId: string;
  vocabulary: { positive: string; zero: string } | null;
}

/** The measure inside THIS protocol version that names THIS evaluator version — anchors have
 *  nothing to be built from without one, so a miss here is the `no_anchors` path, never a refusal
 *  of the call itself (an evaluator may legitimately have no measure bound yet, and the contract
 *  wants that reported as an evidence-shaped answer, not an error). */
async function resolveMeasure(
  p: pg.Pool, protocolVersionId: string, evaluatorVersionId: string,
): Promise<MeasureBinding | null> {
  const row = (await p.query<{ id: string; definition: unknown }>(`
    select m.id::text as id, m.definition as definition
      from zz.eval_measure m
      join zz.eval_dimension d on d.id = m.dimension_id
     where d.protocol_version_id = $1::uuid and m.evaluator_version_id = $2::uuid
     limit 1`, [protocolVersionId, evaluatorVersionId])).rows[0];
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

/** The one shape both `evaluator_qualify`'s own transaction and a direct caller need to write
 *  the row through: a plain pool for a standalone caller, a transaction's own client when the
 *  write has to commit atomically with something else. Mirrors `idempotency.ts`'s own
 *  `Queryable` — an explicit generic signature, not `Pick<pg.Pool, "query">`, which TypeScript
 *  infers as a non-callable union over `Pool`'s overloads. */
interface Writer {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** The qualification run itself (FR-16), factored out of the tool body so `replay-derive.ts`
 *  (Task I-14, FR-60 rule 1) can run it directly — "`replay_case_set_build` runs
 *  `evaluator_qualify` for it first when no such qualification exists" is this function, called
 *  with no `idempotency_key` of its own because it runs at most once per non-replayed
 *  `replay_case_set_build` call, itself already inside THAT tool's own FR-59 ledger transaction.
 *  `evaluator_qualify`'s own tool handler below is the other caller, inside its own ledger. */
export async function performQualification(
  p: pg.Pool, writer: Writer, protocolVersionId: string, evaluatorVersionId: string,
  protocol: ProtocolContext, stableKey: string, principal: string,
): Promise<QualifyResult> {
  const measure = await resolveMeasure(p, protocolVersionId, evaluatorVersionId);
  const { thresholds } = resolveThresholds(protocol.policy?.thresholds);

  const snapshot = measure ? await latestSnapshot(p, protocol.pluginId, false) : null;
  const foreignSnapshot = measure && snapshot ? await latestSnapshot(p, protocol.pluginId, true) : null;

  const counted = await gatherCountedEvidence({
    evaluatorVersionId, principal, snapshot, foreignSnapshot,
    vocabulary: measure?.vocabulary ?? null,
  });
  const mappings = parseLabelMappings(protocol.policy?.labelMappings ?? []);
  const labels = measure
    ? await labelEvidence(p, measure.measureId, evaluatorVersionId, mappingFor(mappings, stableKey))
    : null;

  const evidence: LadderEvidence = { ...counted, labels };
  const { state, reason } = qualificationState(evidence, thresholds);

  const row = (await writer.query<{ id: string }>(`
    insert into zz.eval_evaluator_qualification
      (evaluator_version_id, protocol_version_id, subject_scope, state, evidence, qualified_at)
    values ($1::uuid, $2::uuid, $3::jsonb, $4, $5::jsonb, now())
    returning id::text as id`,
    [evaluatorVersionId, protocolVersionId, JSON.stringify({ plugin_id: protocol.pluginId }),
     state, JSON.stringify({ ...evidence, reason })])).rows[0];
  if (!row) throw new Error("insert into zz.eval_evaluator_qualification produced no row");

  return respond(evidence, state, reason, row.id);
}

export function registerEvaluatorQualifyTools(server: McpServer): void {
  server.registerTool(
    "evaluator_qualify",
    {
      description:
        "WHEN a registered evaluator version needs its qualification state established (or " +
        "re-established) against one protocol version, before its answers may back a score: " +
        "runs the protocol's own QualificationPolicy over four evidence categories — anchors " +
        "(known answers derived from the plugin's own OBSERVE snapshot facts), planted faults " +
        "(the same facts, sign-flipped, killed when the evaluator's answer flips with them), " +
        "controls (the same facts read off another plugin's own real snapshot, never a " +
        "mutation) and stability (one anchor asked three times) — plus labels, ONLY where the " +
        "protocol's qualification.labelMappings names this evaluator's stable_key. RETURNS " +
        "{ qualification_id, state, evidence: { anchors: {passed, total}, planted_faults: " +
        "{killed, total}, controls: {failed_as_expected, total}, stability: {agreeing, total}, " +
        "labels: {n, tpr, tnr} | null } }, writing exactly one zz.eval_evaluator_qualification " +
        "row scoped to { plugin_id } (derived from the protocol, since a bare " +
        "protocol_version_id/evaluator_version_id pair names no subject_scope on its own). " +
        "REFUSES an unknown protocol_version_id or evaluator_version_id; NEVER refuses on thin " +
        "evidence — no anchor can be built (no measure in this protocol version names this " +
        "evaluator, or the measure's own definition.qualification names no {positive, zero} " +
        "vocabulary, or the plugin has no OBSERVE snapshot yet) answers state=unqualified, " +
        "reason=no_anchors instead. A mutator: writes through the FR-59 idempotency ledger, so " +
        "a retried call with the same idempotency_key replays the same row rather than " +
        "re-asking any model.",
      inputSchema: {
        protocol_version_id: z.string(),
        evaluator_version_id: z.string(),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ protocol_version_id, evaluator_version_id, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const protocol = await resolveProtocol(p, protocol_version_id);
      if (!protocol) return text("ERROR: unknown protocol_version_id");
      const stableKey = await resolveEvaluator(p, evaluator_version_id);
      if (!stableKey) return text(`ERROR: "${evaluator_version_id}" is not a registered evaluator version`);

      const principal = parseCaller(requestHeaders()).email;

      const outcome: IdempotencyOutcome<QualifyResult> = await withIdempotency(
        principal, "evaluator_qualify", idempotency_key,
        { protocol_version_id, evaluator_version_id },
        async (client): Promise<MutatorOutcome<QualifyResult>> => {
          const result = await performQualification(
            p, client, protocol_version_id, evaluator_version_id, protocol, stableKey, principal);
          return { result, result_table: "zz.eval_evaluator_qualification", result_id: result.qualification_id };
        },
      );

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
        user: principal, action: "evaluator_qualify", protocol_version_id, evaluator_version_id,
        state: result.state, replayed: outcome.replayed,
      });
      return json(result);
    },
  );
}
