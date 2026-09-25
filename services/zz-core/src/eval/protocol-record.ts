/**
 * `protocol_record`'s own writer (FR-4, FR-6, Task I-10): validates an `EvaluationProtocol` body,
 * writes it as an immutable `zz.eval_protocol_version` with its dimensions and measures, and
 * folds DISCOVER's accepted/merged failure-mode lineage in. `protocol.ts` calls
 * `recordProtocolVersion` once the body has already passed `EvaluationProtocol.safeParse` — this
 * file's job starts after that, and never re-validates the zod shape.
 *
 * No update path exists: `zz.eval_protocol_version` is `unique(protocol_id, version)` and this
 * file only ever inserts. A body whose `version` does not name the next number after this
 * plugin's newest is refused before anything is written — see `nextVersionRefusal`.
 *
 * Body field → migration 002 column, positionally, never renamed: `pluginPurpose` → `purpose`,
 * `observableSurfaces` → `observable_surfaces`, `failureTaxonomy` → `failure_taxonomy`, `suites`
 * → `suites`, `replay` → `replay_policy`, `qualification` → `qualification_policy`, `scoring` →
 * `scoring_policy`, `improvement` → `improvement_policy`. `packages/contracts/src/eval-protocol.ts`
 * states the same mapping; nothing here restates the field names a third time.
 */
import { createHash } from "node:crypto";

import type { EvaluationProtocol } from "@zz/contracts";
import type pg from "pg";

import { canonicalJson } from "./idempotency.js";
import { registerEvaluator, type EvaluatorDefinition } from "./evaluators.js";
import { OBSERVATION_FACT_KEYS } from "./observe-facts.js";

const sha256Digest = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// Postgres's own code for "unique_violation" — idempotency.ts and evaluators.ts each name this
// constant for the same race; this file's own copy is the version-slot race two different
// idempotency_key values could hit at once.
const UNIQUE_VIOLATION = "23505";

/** A measure's freeform `evaluator` object, narrowed to what `registerEvaluator` needs — 002's
 *  CHECK requires `evaluator_version_id` for a `bounded_semantic`/`generative_critic` measure, so
 *  this is where that requirement is actually enforced, with a message naming the measure rather
 *  than a CHECK violation's raw SQL text. */
function asEvaluatorDefinition(raw: unknown, measureKey: string): EvaluatorDefinition | string {
  if (!raw || typeof raw !== "object") {
    return `measure "${measureKey}" is bounded_semantic/generative_critic and carries no ` +
      "evaluator — give stable_key, kind, question, answer_schema, polarity and model_policy";
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.stable_key !== "string" || !r.stable_key.trim()) {
    return `measure "${measureKey}"'s evaluator names no stable_key`;
  }
  if (typeof r.kind !== "string") return `measure "${measureKey}"'s evaluator names no kind`;
  if (typeof r.question !== "string" || !r.question.trim()) {
    return `measure "${measureKey}"'s evaluator names no question`;
  }
  if (!r.answer_schema || typeof r.answer_schema !== "object") {
    return `measure "${measureKey}"'s evaluator names no answer_schema`;
  }
  return {
    stable_key: r.stable_key, kind: r.kind as EvaluatorDefinition["kind"],
    question: r.question, answer_schema: r.answer_schema as EvaluatorDefinition["answer_schema"],
    polarity: (r.polarity as Record<string, unknown>) ?? {},
    model_policy: (r.model_policy as Record<string, unknown>) ?? {},
  };
}

/** A `deterministic`/`outcome` measure's `definition.factPath` refused, by name, when it names no
 *  fact OBSERVE actually computes — the idea the removed legacy ruler's quantitative lines were
 *  held to (a `reads` dotted path checked against the profile sheet), applied here against
 *  `observe-facts.ts`'s own `OBSERVATION_FACT_KEYS` instead: only the path's FIRST segment is checked against that list — a nested path underneath
 *  a resolved fact is `evaluate-measures.ts`'s own business at read time, not something this
 *  file's static, pre-observation check can validate. `null` on a valid measure; this file's own
 *  Fix dispatch note (I-29) is what this refusal answers. */
export function factPathRefusal(
  measure: { key: string; evaluatorType: string; definition: Record<string, unknown> },
): string | null {
  if (measure.evaluatorType !== "deterministic" && measure.evaluatorType !== "outcome") return null;
  const factPath = measure.definition.factPath;
  if (typeof factPath !== "string" || !factPath.trim()) {
    return `measure "${measure.key}" is deterministic/outcome and names no definition.factPath`;
  }
  const top = factPath.split(".")[0];
  if (!(OBSERVATION_FACT_KEYS as readonly string[]).includes(top)) {
    return `measure "${measure.key}"'s factPath "${factPath}" names no fact OBSERVE computes — ` +
      `one of ${OBSERVATION_FACT_KEYS.join(", ")}`;
  }
  const normalize = measure.definition.normalize;
  if (normalize !== undefined && normalize !== "rate" && normalize !== "inverted_rate" && normalize !== "threshold") {
    return `measure "${measure.key}"'s normalize "${String(normalize)}" is none of rate, inverted_rate, threshold`;
  }
  if (normalize === "threshold" && typeof measure.definition.max !== "number" && typeof measure.definition.min !== "number") {
    return `measure "${measure.key}" declares normalize:"threshold" but names no max or min`;
  }
  return null;
}

/** Every `improvement.criticalGuardrails[].key` refused, by name, when it resolves to zero or more
 *  than one measure across this protocol body's own dimensions — `evaluateGuardrails`
 *  (evaluate-measures.ts) reads a guardrail by measure key alone, so a key that names nothing, or
 *  names more than one measure, is a protocol that cannot be evaluated the way it claims to be.
 *  `null` when every guardrail resolves to exactly one measure. */
export function criticalGuardrailRefusal(
  body: { dimensions: readonly { measures: readonly { key: string }[] }[]; improvement: { criticalGuardrails: readonly { key: string }[] } },
): string | null {
  const allMeasureKeys = body.dimensions.flatMap((d) => d.measures.map((m) => m.key));
  for (const g of body.improvement.criticalGuardrails) {
    const matches = allMeasureKeys.filter((k) => k === g.key);
    if (matches.length === 0) {
      return `improvement.criticalGuardrails names measure key "${g.key}", which no dimension's measure declares`;
    }
    if (matches.length > 1) {
      return `improvement.criticalGuardrails names measure key "${g.key}", which ${matches.length} ` +
        "measures across this protocol's dimensions declare — a guardrail key must resolve to exactly one measure";
    }
  }
  return null;
}

/** Every `evaluator_version_id` a `bounded_semantic`/`generative_critic` measure resolves to,
 *  keyed by `dimensionKey.measureKey` — registered ahead of the ledger, the same reason
 *  `discover.ts` registers `discover.owner_kind` ahead of it: `registerEvaluator` reaches its own
 *  pool through `db()` and is idempotent by content, so calling it before the transaction costs
 *  one upsert-and-read-back and never mints a duplicate version. Returns a refusal string on the
 *  first bad measure. */
async function resolveMeasureEvaluators(
  body: EvaluationProtocol,
): Promise<Map<string, string> | string> {
  const resolved = new Map<string, string>();
  for (const dim of body.dimensions) {
    for (const measure of dim.measures) {
      if (measure.evaluatorType !== "bounded_semantic" && measure.evaluatorType !== "generative_critic") continue;
      const def = asEvaluatorDefinition(measure.evaluator, `${dim.key}.${measure.key}`);
      if (typeof def === "string") return def;
      const version = await registerEvaluator(def);
      resolved.set(`${dim.key}.${measure.key}`, version.evaluator_version_id);
    }
  }
  return resolved;
}

/** The next version this plugin's protocol lineage must declare, or a refusal naming what it
 *  actually is. `zz.eval_protocol_version` has no update path, so a body that does not name the
 *  next number is not "recording a change" — it is either a stale re-read (name the real next
 *  number) or an attempt to edit history (refused the same way). */
function nextVersionRefusal(bodyVersion: number, currentMax: number | null): string | null {
  const want = (currentMax ?? 0) + 1;
  if (bodyVersion === want) return null;
  return `REFUSED: this protocol's next version is ${want} (its newest recorded is ` +
    `${currentMax ?? "none yet"}), and the body named version ${bodyVersion}. There is no update ` +
    "path for a recorded protocol version — read it back with protocol_read, and record the " +
    "next number.";
}

/** A `failureTaxonomy` entry naming DISCOVER lineage — the object half of `FailureMode`
 *  (`packages/contracts/src/eval-protocol.ts`), narrowed to the two fields this file's own
 *  writing convention reads off it. A bare string entry, or an object naming neither field,
 *  carries no lineage and is written into `failure_taxonomy` unchanged with nothing else done.
 *
 *  DELIBERATE, and this task's own convention rather than one the plan states: `failureTaxonomy`
 *  is typed `FailureMode = string | { key: string } & Record<string, unknown>` precisely because
 *  spec v8 leaves a taxonomy entry's shape open. `candidateId` accepts the one DISCOVER candidate
 *  this entry was written from; `mergedCandidateIds` names others folded into the same entry. */
interface TaxonomyLineage { key?: unknown; candidateId?: unknown; mergedCandidateIds?: unknown }

/** Every candidate `failureTaxonomy` accepts or merges, validated against this protocol's own
 *  plugin before any row is touched — a candidate from another plugin's evidence is refused
 *  rather than silently attached to a taxonomy it says nothing about. */
async function lineageRefusal(
  client: pg.PoolClient, pluginId: string, body: EvaluationProtocol,
): Promise<string | null> {
  const ids: string[] = [];
  for (const entry of body.failureTaxonomy) {
    if (typeof entry === "string") continue;
    const t = entry as TaxonomyLineage;
    if (typeof t.candidateId === "string") ids.push(t.candidateId);
    if (Array.isArray(t.mergedCandidateIds)) {
      for (const m of t.mergedCandidateIds) if (typeof m === "string") ids.push(m);
    }
  }
  if (!ids.length) return null;
  const { rows } = await client.query<{ id: string }>(`
    select c.id::text as id
      from zz.eval_failure_mode_candidate c
      join zz.eval_observation_snapshot os on os.id = c.observation_snapshot_id
      join zz.eval_subject_version sv on sv.id = os.subject_version_id
     where sv.plugin_id = $1::uuid and c.id = any($2::uuid[])`, [pluginId, ids]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (!missing.length) return null;
  return `REFUSED: failureTaxonomy names candidateId(s) ${missing.join(", ")}, which name no ` +
    "zz.eval_failure_mode_candidate row from THIS plugin's own observation snapshots — lineage " +
    "can only point at evidence DISCOVER mined for the plugin this protocol version is about.";
}

/** Applies the lineage `lineageRefusal` already validated: an accepted candidate's status moves
 *  to `accepted` and takes the taxonomy entry's `key` as its `stable_key`; every candidate it
 *  names in `mergedCandidateIds` moves to `merged`, pointed at the accepted one. Run inside the
 *  same transaction as the version/dimension/measure inserts below — lineage and the version it
 *  belongs to land together or not at all. */
async function applyLineage(client: pg.PoolClient, body: EvaluationProtocol): Promise<void> {
  for (const entry of body.failureTaxonomy) {
    if (typeof entry === "string") continue;
    const t = entry as TaxonomyLineage;
    const key = typeof t.key === "string" ? t.key : null;
    if (typeof t.candidateId === "string") {
      await client.query(
        `update zz.eval_failure_mode_candidate set status = 'accepted', stable_key = coalesce($2, stable_key)
          where id = $1::uuid`, [t.candidateId, key]);
    }
    if (Array.isArray(t.mergedCandidateIds) && typeof t.candidateId === "string") {
      const merged = t.mergedCandidateIds.filter((m): m is string => typeof m === "string");
      if (merged.length) {
        await client.query(
          `update zz.eval_failure_mode_candidate set status = 'merged', merged_into_id = $2::uuid
            where id = any($1::uuid[])`, [merged, t.candidateId]);
      }
    }
  }
}

interface RecordedVersion { protocol_version_id: string; content_digest: string }

/** Everything `protocol_record` needs beyond the validated body: which plugin (from the caller's
 *  `subject_version_id`, resolved by `protocol.ts`) and the transaction client `withIdempotency`
 *  handed in — every write below lands in that one transaction, alongside the idempotency
 *  ledger's own insert, or none of it does. */
export async function recordProtocolVersion(
  client: pg.PoolClient, pluginId: string, body: EvaluationProtocol,
): Promise<RecordedVersion | string> {
  // Checked first, purely in memory, before any evaluator is registered or written: a protocol
  // whose factPath/criticalGuardrails content is wrong should not leave a half-registered
  // evaluator version behind for a caller who fixes the typo and tries again.
  for (const dim of body.dimensions) {
    for (const measure of dim.measures) {
      const factIssue = factPathRefusal(measure);
      if (factIssue) return `REFUSED: ${factIssue}`;
    }
  }
  const guardrailIssue = criticalGuardrailRefusal(body);
  if (guardrailIssue) return `REFUSED: ${guardrailIssue}`;

  const evaluators = await resolveMeasureEvaluators(body);
  if (typeof evaluators === "string") return `REFUSED: ${evaluators}`;

  const protocolId = (await client.query<{ id: string }>(`
    insert into zz.eval_protocol (plugin_id, protocol_key) values ($1::uuid, $2)
    on conflict (plugin_id, protocol_key) do update set protocol_key = excluded.protocol_key
    returning id::text as id`, [pluginId, body.protocolKey])).rows[0].id;

  const maxRow = (await client.query<{ max: number | null }>(
    `select max(version) as max from zz.eval_protocol_version where protocol_id = $1::uuid`,
    [protocolId])).rows[0];
  const versionRefusal = nextVersionRefusal(body.version, maxRow?.max ?? null);
  if (versionRefusal) return versionRefusal;

  const lineageBad = await lineageRefusal(client, pluginId, body);
  if (lineageBad) return lineageBad;

  const digest = sha256Digest(canonicalJson(body));

  let versionRow: { id: string };
  try {
    versionRow = (await client.query<{ id: string }>(`
      insert into zz.eval_protocol_version
        (protocol_id, version, subject_compatibility, purpose, observable_surfaces,
         failure_taxonomy, suites, replay_policy, qualification_policy, scoring_policy,
         improvement_policy, content_digest, approved_document_path, created_at)
      values ($1::uuid, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
              $10::jsonb, $11::jsonb, $12, null, now())
      returning id::text as id`,
      [protocolId, body.version,
       // `subject_compatibility`: the one subject version this recording actually happened
       // against, recorded rather than guessed at — protocol_read's own triggers (not this
       // column) are what decide whether a LATER subject version still fits it.
       JSON.stringify({ plugin_id: pluginId }),
       body.pluginPurpose, JSON.stringify(body.observableSurfaces), JSON.stringify(body.failureTaxonomy),
       JSON.stringify(body.suites), JSON.stringify(body.replay), JSON.stringify(body.qualification),
       JSON.stringify(body.scoring), JSON.stringify(body.improvement), digest])).rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      return `REFUSED: version ${body.version} of this protocol was just recorded by another ` +
        "call — read it back with protocol_read before trying again.";
    }
    throw err;
  }
  const protocolVersionId = versionRow.id;

  for (const dim of body.dimensions) {
    const dimRow = (await client.query<{ id: string }>(`
      insert into zz.eval_dimension
        (protocol_version_id, key, name, canonical_kind, weight, required, applicable, not_applicable_reason)
      values ($1::uuid, $2, $3, $4, $5, $6, $7,
              -- 002's CHECK pairs applicable/not_applicable_reason strictly: null on one side,
              -- a real string on the other. The zod schema above only requires a reason when
              -- NOT applicable; a stray one on an applicable dimension is dropped here rather
              -- than sent through to a CHECK violation the caller cannot read a message from.
              case when $7 then null else $8 end)
      returning id::text as id`,
      [protocolVersionId, dim.key, dim.name, dim.canonicalKind, dim.weight, dim.required,
       dim.applicable, dim.notApplicableReason])).rows[0];
    for (const measure of dim.measures) {
      const evaluatorVersionId = evaluators.get(`${dim.key}.${measure.key}`) ?? null;
      await client.query(`
        insert into zz.eval_measure
          (dimension_id, key, evaluator_type, weight, suite, required, definition, evaluator_version_id)
        values ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid)`,
        [dimRow.id, measure.key, measure.evaluatorType, measure.weight, measure.suite,
         measure.required, JSON.stringify(measure.definition), evaluatorVersionId]);
    }
  }

  await applyLineage(client, body);

  return { protocol_version_id: protocolVersionId, content_digest: digest };
}
