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
 * A qualification is about a MEASURE (Task I-23's reshape): the row names `measure_id` and who
 * qualified it (`qualified_by`), and the evaluator version and the protocol version are both
 * reached through that measure — `subject_scope` said only what the measure's own protocol
 * already says, and `evaluator_qualify` refuses a measure key two dimensions share, so the
 * measure a row names is the one the evaluator was qualified for.
 *
 * DELIBERATE: the caller names the measure by `measure_key`, never an `evaluator_version_id`.
 * The key is what the define stage wrote into `protocol_body`; the evaluator version is minted
 * inside `protocol_record` and no tool returns it, so a contract that asked for it sent the agent
 * to read a table it has no door to. The measure resolves the evaluator version through the
 * protocol version the caller already names.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MeasureQualification, QualificationPolicy, parseCaller, type MeasureAnchor } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import {
  gatherCountedEvidence, labelEvidence, mappingFor, parseLabelMappings, type AnchorResult,
} from "./qualify-evidence.js";
import { qualificationState, resolveThresholds, type LadderEvidence } from "./qualify-ladder.js";
import { recordQualified } from "./stage-record.js";
import {
  decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome,
} from "./idempotency.js";
import { askEvaluatorQuestion, insertEvaluatorAnswer, type AskedEvaluatorAnswer } from "../semantic.js";
import { platformEvent } from "../indexing.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no evaluator can be qualified");
const MODEL_BACKED = new Set(["bounded_semantic", "generative_critic"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `resolveProtocol` answers — `evaluate.ts` resolves the same protocol context before it
 *  scores, one resolver, so the two callers can never read a protocol's policy differently. */
interface ProtocolContext {
  pluginId: string; policy: QualificationPolicy | null; version: number; affirmed: boolean;
}

export async function resolveProtocol(p: pg.Pool, protocolVersionId: string): Promise<ProtocolContext | null> {
  if (!UUID_RE.test(protocolVersionId)) return null;
  const row = (await p.query<{ plugin_id: string; qualification_policy: unknown; version: number; affirmed: boolean }>(`
    select pv.plugin_id::text as plugin_id, pv.qualification_policy as qualification_policy,
           pv.version, pv.approved_doc_id is not null as affirmed
      from zz.eval_protocol_version pv
     where pv.id = $1::uuid`, [protocolVersionId])).rows[0];
  if (!row) return null;
  const parsed = QualificationPolicy.safeParse(row.qualification_policy);
  return { pluginId: row.plugin_id, policy: parsed.success ? parsed.data : null, version: row.version, affirmed: row.affirmed };
}

/** FR-6's gate, read where it matters: `protocol_record` writes every version with `approved_doc_id`
 *  null, and only `protocol_affirm` fills the three affirmation fields, once, once a person
 *  approved the `protocol.md` quoting its digest. Nothing is qualified or scored against a
 *  version that never got there. No exemption for a bootstrap protocol: it is
 *  recorded through `protocol_record` like any other body and affirmed the same way —
 *  `scoring.establishment.bootstrap` only caps what its score may claim. */
export function unaffirmedRefusal(protocolVersionId: string, protocol: ProtocolContext): string | null {
  if (protocol.affirmed) return null;
  return `ERROR: protocol_version_id ${protocolVersionId} (version ${protocol.version}) has not been affirmed — ` +
    "write protocol.md quoting its content_digest, get it approved, and call protocol_affirm first; " +
    "nothing is qualified or scored against a protocol nobody agreed";
}

/** The evaluator version's stable key — its identity, and now its own column: `zz.eval_evaluator`
 *  was a header carrying the key and a `kind` nothing read, and the phase-3 migration folded it
 *  onto the version. */
async function resolveEvaluator(p: pg.Pool, evaluatorVersionId: string): Promise<string | null> {
  if (!UUID_RE.test(evaluatorVersionId)) return null;
  const row = (await p.query<{ stable_key: string }>(`
    select v.stable_key as stable_key
      from zz.eval_evaluator_version v
     where v.id = $1::uuid`, [evaluatorVersionId])).rows[0];
  return row ? row.stable_key : null;
}

/** A `measure_key` inside one protocol version, resolved to its row — or the refusal, by name.
 *  `protocol_record` refuses a body that repeats a key anywhere in it (`duplicateMeasureKeyRefusal`),
 *  but migration 001 carries no such constraint and a version recorded before that refusal may
 *  still share one across two dimensions — refused here naming both rather than resolved to
 *  whichever row came first. Exported for `finding_record` (plugin-record.ts), which cites a
 *  measure by the same key: one resolver, so the two can never read a key differently.
 *
 *  Read off the measure's own `protocol_version_id` (the phase-3 shape): a measure names its
 *  protocol version itself now, and the join to its dimension is kept only to name the dimension
 *  in the duplicate-key refusal. */
export async function measureByKey(
  p: pg.Pool, protocolVersionId: string, measureKey: string,
): Promise<{ id: string; evaluator_type: string; evaluator_version_id: string | null } | { error: string }> {
  const rows = (await p.query<{ id: string; key: string; dimension: string; evaluator_type: string; evaluator_version_id: string | null }>(`
    select m.id::text as id, m.key, d.key as dimension, m.evaluator_type,
           m.evaluator_version_id::text as evaluator_version_id
      from zz.eval_measure m join zz.eval_dimension d on d.id = m.dimension_id
     where m.protocol_version_id = $1::uuid
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

/** The measure's own known-answer texts (`definition.qualification.anchors`). An empty list — a
 *  version recorded without them, or a definition that no longer parses — is the `no_anchors`
 *  path, never a refusal of the call itself (the contract wants that reported as an
 *  evidence-shaped answer, not an error).
 *
 *  DELIBERATE: by id, never re-found by evaluator version. Two measures may defer to the same
 *  evaluator version (`registerEvaluator` is idempotent by content), and a `limit 1` lookup would
 *  read whichever one's anchors came first rather than the measure the caller named. */
async function measureAnchors(p: pg.Pool, measureId: string): Promise<MeasureAnchor[]> {
  const row = (await p.query<{ definition: unknown }>(
    "select definition from zz.eval_measure where id = $1::uuid", [measureId])).rows[0];
  const def = (row?.definition ?? {}) as Record<string, unknown>;
  const parsed = MeasureQualification.safeParse(def.qualification);
  return parsed.success ? parsed.data.anchors : [];
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
    results: readonly AnchorResult[];
  };
}

function respond(
  counted: LadderEvidence, results: readonly AnchorResult[], state: string, reason: string | null, qualificationId: string,
): QualifyResult {
  return {
    qualification_id: qualificationId, state,
    evidence: {
      anchors: { passed: counted.anchors.passed, total: counted.anchors.total },
      planted_faults: { killed: counted.planted_faults.passed, total: counted.planted_faults.total },
      controls: { failed_as_expected: counted.controls.passed, total: counted.controls.total },
      stability: { agreeing: counted.stability.passed, total: counted.stability.total },
      labels: counted.labels, reason, results,
    },
  };
}

/** Anything `recordQualification` writes through: the ledger transaction's own client in
 *  `evaluator_qualify`. Mirrors
 *  `idempotency.ts`'s own `Queryable` — an explicit generic signature, not
 *  `Pick<pg.Pool, "query">`, which TypeScript infers as a non-callable union over `Pool`'s
 *  overloads. */
interface Writer {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** One qualification run, decided and not yet written: the ladder's state, the evidence behind
 *  it, and every evaluator answer asked on the way, in ask order. `measureId` is the subject of
 *  the row and `qualifiedBy` the principal it names — a qualification is about a measure, and who
 *  qualified it is a person, not a scope. */
interface GatheredQualification {
  readonly measureId: string;
  readonly evaluatorVersionId: string;
  readonly qualifiedBy: string;
  readonly state: string;
  readonly reason: string | null;
  readonly evidence: LadderEvidence;
  readonly results: readonly AnchorResult[];
  readonly asked: readonly AskedEvaluatorAnswer[];
}

/** The qualification run itself (FR-16), split in two so no model call ever runs inside a
 *  transaction: this half reads on the pool and asks every question (each declared anchor, fault
 *  and control, three times each) and writes nothing;
 *  `recordQualification` writes the answers and the row through `evaluator_qualify`'s ledger
 *  transaction client. */
async function gatherQualification(
  p: pg.Pool, evaluatorVersionId: string, measureId: string,
  qualifiedBy: string, protocol: ProtocolContext, stableKey: string, principal: string,
): Promise<GatheredQualification> {
  const anchors = await measureAnchors(p, measureId);
  const { thresholds } = resolveThresholds(protocol.policy?.thresholds);

  const asked: AskedEvaluatorAnswer[] = [];
  const { counts, results } = await gatherCountedEvidence({
    anchors,
    ask: async (subject) => {
      const answer = await askEvaluatorQuestion({
        evaluator_version_id: evaluatorVersionId, subject_text: subject, askedBy: principal,
      });
      asked.push(answer);
      return answer.result;
    },
  });
  const mappings = parseLabelMappings(protocol.policy?.labelMappings ?? []);
  const labels = await labelEvidence(p, measureId, mappingFor(mappings, stableKey));

  const evidence: LadderEvidence = { ...counts, labels };
  const { state, reason } = qualificationState(evidence, thresholds);
  return { measureId, evaluatorVersionId, qualifiedBy, state, reason, evidence, results, asked };
}

/** The write half: every asked answer's `zz.assessment` row, then the one
 *  `zz.eval_evaluator_qualification` row — all through `writer`, so they commit or roll back
 *  together with the caller's ledger row. Database writes only; never asks. */
async function recordQualification(writer: Writer, g: GatheredQualification): Promise<QualifyResult> {
  for (const answer of g.asked) await insertEvaluatorAnswer(writer, answer);
  const row = (await writer.query<{ id: string }>(`
    insert into zz.eval_evaluator_qualification
      (measure_id, state, evidence, qualified_by, qualified_at)
    values ($1::uuid, $2, $3::jsonb, $4::uuid, now())
    returning id::text as id`,
    [g.measureId, g.state,
     JSON.stringify({ ...g.evidence, reason: g.reason, results: g.results }), g.qualifiedBy])).rows[0];
  if (!row) throw new Error("insert into zz.eval_evaluator_qualification produced no row");

  return respond(g.evidence, g.results, g.state, g.reason, row.id);
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
        "protocol's own QualificationPolicy thresholds over the measure's OWN known-answer texts, " +
        "declared in protocol_body as definition.qualification.anchors [{ id, role, text, expected }], " +
        "each asked the measure's own question three times and passed only when all three answers are its " +
        "expected: role anchor (anchor pass rate), fault (a good example with one planted defect — killed when " +
        "the answer flips) and control (an artifact of another kind) — plus labels, ONLY where the " +
        "protocol's qualification.labelMappings names this evaluator's stable_key; stability is the share of " +
        "texts whose three answers agree. RETURNS " +
        "{ measure_key, evaluator_version_id, qualification_id, state, evidence: { anchors: " +
        "{passed, total}, planted_faults: {killed, total}, controls: {failed_as_expected, total}, " +
        "stability: {agreeing, total}, labels: {n, tpr, tnr} | null, reason, results: [{ id, role, " +
        "expected, got }] } }, writing exactly one " +
        "zz.eval_evaluator_qualification row naming that measure and who qualified it — the " +
        "evaluator version and the protocol version are both read through the measure. " +
        "reason names every threshold that stopped the climb, as '<key> <rate> < <bar> (passed/total)'. " +
        "REFUSES an unknown protocol_version_id; one protocol_affirm has not bound (not yet approved); " +
        "a measure_key this protocol version does not " +
        "have (naming the keys it does have); a key two dimensions share; and a " +
        "deterministic/outcome/human measure, which is not qualified. NEVER refuses on thin " +
        "evidence — a measure with no declared anchors answers state=unqualified, " +
        "reason=no_anchors instead. A mutator: writes through the " +
        "idempotency ledger, so a retried call with the same idempotency_key replays the same " +
        "row rather than re-asking any model. Pass `initiative` to record the state on the initiative.",
      inputSchema: {
        protocol_version_id: z.string(),
        measure_key: z.string().min(1).describe("The measure's key as written in protocol_body."),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe("The initiative this evaluation runs in: records this measure's qualification state, which initiative_status reads to route to EVALUATE once every owed measure has one."),
      },
    },
    async ({ protocol_version_id, measure_key, idempotency_key, initiative }) => {
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
      // The row names who qualified it: `qualified_by` is a principal, and an address no
      // principal carries is refused rather than written as an attribution nobody has.
      const who = (await p.query<{ id: string }>(
        "select id::text as id from zz.principal where lower(email) = lower($1) limit 1",
        [principal])).rows[0];
      if (!who) return text(`ERROR: no zz.principal carries "${principal}", so this qualification has nobody to name`);

      // Every model call happens before the transaction: a retry is ruled out first (so it never
      // re-asks), then the ladder asks on the pool, then the transaction only writes.
      const args = { protocol_version_id, measure_key };
      const prior = await decideBeforeWork(principal, "evaluator_qualify", idempotency_key, args);
      let outcome: IdempotencyOutcome<QualifyResult>;
      if (prior.replayed) {
        outcome = prior;
      } else {
        const gathered = await gatherQualification(
          p, evaluator_version_id, measure.id, who.id, protocol, stableKey, principal);
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

      platformEvent({
        actor: principal, kind: "evaluator_qualify", initiative, protocol_version_id, measure_key, evaluator_version_id,
        state: result.state, replayed: outcome.replayed,
      });
      const recorded = await recordQualified(initiative, protocol_version_id, measure_key, result.state);
      return json({ measure_key, evaluator_version_id, ...result, ...recorded });
    },
  );
}
