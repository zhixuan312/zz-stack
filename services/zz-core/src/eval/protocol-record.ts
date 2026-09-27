/**
 * `protocol_record`'s own writer (FR-4, FR-6, Task I-10; folded and reshaped by Task I-23):
 * validates an `EvaluationProtocol` body, writes it as an immutable `zz.eval_protocol_version`
 * with its dimensions and measures, and folds DISCOVER's failure-mode lineage in as
 * `eval_protocol_failure_mode` rows. `protocol.ts` calls `recordProtocolVersion` once the body has
 * already passed `EvaluationProtocol.safeParse` — this file's job starts after that, and never
 * re-validates the zod shape.
 *
 * No update path exists: `zz.eval_protocol_version` is `unique (plugin_id, version)` and this
 * file only ever inserts. A body whose `version` does not name the next number after this
 * plugin's newest is refused before anything is written — see `nextVersionRefusal`.
 *
 * The two header tables are gone and their facts live on the version: `zz.eval_protocol` carried
 * a plugin and a key and nothing else, so `plugin_id` + `protocol_key` are written onto the
 * version (`unique (plugin_id, version)` is then the identity), and whose version it is is the
 * caller's own principal id (`recorded_by`). `zz.eval_evaluator` went the same way —
 * `evaluators.ts` writes `stable_key` onto the version it registers.
 *
 * Body field → column, positionally, never renamed: `pluginPurpose` → `purpose`,
 * `observableSurfaces` → `observable_surfaces` (a text array now, not jsonb), `version`,
 * `qualification` → `qualification_policy`, `scoring` → `scoring_policy`, `improvement` →
 * `improvement_policy`. Three of the body's own fields have no column in the target shape and
 * are not stored: `suites` (dropped — a measure's own `evaluator_type` is how it is evaluated),
 * and `improvement.evolvable` and `improvement.criticalGuardrails` (dropped from the policy: who
 * may release a candidate is the plugin's own `plugin_release_owner` rows, and a guardrail is a
 * measure's `guardrail_threshold`). `packages/contracts/src/eval-protocol.ts` states the body's
 * own names; nothing here restates them a third time.
 *
 * Three measure facts that used to live inside `definition` jsonb are columns now —
 * `fact_key` (`definition.factPath`), `subject_kind` (`definition.subjectKind`) and
 * `guardrail_threshold` (the threshold of the `improvement.criticalGuardrails` entry naming this
 * measure) — so a deterministic measure's fact and a guardrail's bar are readable without
 * parsing a jsonb bag. Each is written only where its own biconditional allows it: a
 * `fact_key` on anything but a `deterministic`/`outcome` measure would violate
 * `eval_measure_fact_key_check`, and a guardrail threshold is only ever the one its key names.
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

/** A measure's freeform `evaluator` object, narrowed to what `registerEvaluator` needs — 001's
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

/** A measure key repeated anywhere in the body, refused by name with the dimensions that repeat
 *  it. Every reader names a measure by key alone across the whole version — `evaluator_qualify`
 *  and `finding_record` (`measureByKey`), a critical guardrail — so a key two dimensions share is
 *  one no caller can name. `null` when every key is unique protocol-wide. */
export function duplicateMeasureKeyRefusal(
  body: { dimensions: readonly { key: string; measures: readonly { key: string }[] }[] },
): string | null {
  const seen = new Map<string, string[]>();
  for (const d of body.dimensions) for (const m of d.measures) seen.set(m.key, [...(seen.get(m.key) ?? []), d.key]);
  const repeated = [...seen].filter(([, dims]) => dims.length > 1);
  if (!repeated.length) return null;
  return "measure keys must be unique across the whole protocol — " +
    repeated.map(([key, dims]) => `"${key}" is declared in ${dims.join(", ")}`).join("; ");
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
 *  writing convention reads off it. A bare string entry names a failure mode's `stable_key`; an
 *  object naming neither field carries no lineage. A taxonomy entry is a NAME for a failure mode,
 *  not evidence of one: only what resolves to this plugin's own evidence is folded in, and what
 *  does not resolve is reported back by name rather than invented (never refused — the reference
 *  protocol in `catalog/zz/zz-plugin-eval/protocols/zz-core.json` lists names of its own that no
 *  DISCOVER run has ever minted a stable key for).
 *
 *  DELIBERATE, and this task's own convention rather than one the plan states: `candidateId`
 *  accepts the one DISCOVER sighting this entry was written from; `mergedCandidateIds` names
 *  others folded into the same entry. Both name sightings now — a failure mode is an identity
 *  and a discovery of it is a sighting (Task I-24) — and each folds its own `failure_mode_id`
 *  in, so two sightings of one identity are one relation row. */
interface TaxonomyLineage { key?: unknown; candidateId?: unknown; mergedCandidateIds?: unknown }

/** What a body's `failureTaxonomy` resolves to: the failure-mode identities to fold into this
 *  version, and the entries' own names that named no failure mode of this plugin at all. */
interface ResolvedLineage { readonly failureModeIds: string[]; readonly unfoldedKeys: string[] }

/** Every candidate `failureTaxonomy` accepts or merges, resolved against this protocol's own
 *  plugin before any row is touched — a sighting from another plugin's evidence is refused
 *  rather than silently attached to a taxonomy it says nothing about. A bare string is a
 *  `stable_key` and is folded in when this plugin has a failure mode under it. */
async function resolveLineage(
  client: pg.PoolClient, pluginId: string, body: EvaluationProtocol,
): Promise<ResolvedLineage | string> {
  const sightingIds = new Set<string>();
  const stableKeys = new Set<string>();
  for (const entry of body.failureTaxonomy) {
    if (typeof entry === "string") { stableKeys.add(entry); continue; }
    const t = entry as TaxonomyLineage;
    if (typeof t.candidateId === "string") sightingIds.add(t.candidateId);
    if (Array.isArray(t.mergedCandidateIds)) {
      for (const m of t.mergedCandidateIds) if (typeof m === "string") sightingIds.add(m);
    }
  }

  const failureModeIds = new Set<string>();
  if (sightingIds.size) {
    const { rows } = await client.query<{ id: string; failure_mode_id: string }>(`
      select s.id::text as id, s.failure_mode_id::text as failure_mode_id
        from zz.eval_failure_mode_sighting s
        join zz.eval_failure_mode fm on fm.id = s.failure_mode_id
       where fm.plugin_id = $1::uuid and s.id = any($2::uuid[])`,
      [pluginId, [...sightingIds]]);
    const known = new Map(rows.map((r) => [r.id, r.failure_mode_id]));
    const missing = [...sightingIds].filter((id) => !known.has(id));
    if (missing.length) {
      return `REFUSED: failureTaxonomy names candidateId(s) ${missing.join(", ")}, which name no ` +
        "zz.eval_failure_mode_sighting from THIS plugin's own observation snapshots — lineage " +
        "can only point at evidence DISCOVER mined for the plugin this protocol version is about.";
    }
    for (const id of known.values()) failureModeIds.add(id);
  }

  const unfolded = new Set(stableKeys);
  if (stableKeys.size) {
    const { rows } = await client.query<{ id: string; stable_key: string }>(`
      select fm.id::text as id, fm.stable_key
        from zz.eval_failure_mode fm
       where fm.plugin_id = $1::uuid and fm.stable_key = any($2::text[])`,
      [pluginId, [...stableKeys]]);
    for (const r of rows) {
      failureModeIds.add(r.id);
      unfolded.delete(r.stable_key);
    }
  }
  return { failureModeIds: [...failureModeIds], unfoldedKeys: [...unfolded] };
}

/** Applies the lineage `resolveLineage` already validated: one `eval_protocol_failure_mode` row
 *  per failure-mode identity this version folds in — the relation that replaced the
 *  `failure_taxonomy` jsonb array, and the fact `protocol-triggers.ts` reads to know which
 *  sightings no protocol version has read yet. Run inside the same transaction as the
 *  version/dimension/measure inserts below — lineage and the version it belongs to land together
 *  or not at all. */
async function applyLineage(
  client: pg.PoolClient, protocolVersionId: string, failureModeIds: readonly string[],
): Promise<void> {
  if (!failureModeIds.length) return;
  await client.query(
    `insert into zz.eval_protocol_failure_mode (protocol_version_id, failure_mode_id)
     select $1::uuid, f.id from unnest($2::uuid[]) as f(id)
     on conflict (protocol_version_id, failure_mode_id) do nothing`,
    [protocolVersionId, failureModeIds]);
}

/** `improvement_policy`, with the two facts the target shape moved elsewhere removed: `evolvable`
 *  (who may release a candidate is the plugin's `plugin_release_owner` rows) and
 *  `criticalGuardrails` (a guardrail is a measure's own `guardrail_threshold`). Everything else
 *  the body declared is stored as written. */
function improvementPolicyOf(improvement: Record<string, unknown>): Record<string, unknown> {
  const policy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(improvement)) {
    if (key === "evolvable" || key === "criticalGuardrails") continue;
    policy[key] = value;
  }
  return policy;
}

/** Each measure's guardrail bar, keyed by the measure key its `improvement.criticalGuardrails`
 *  entry names. `criticalGuardrailRefusal` has already refused a key that resolves to no measure
 *  or to more than one, so every entry here names exactly one measure. */
function guardrailsByMeasureKey(body: EvaluationProtocol): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of body.improvement.criticalGuardrails) {
    if (typeof g.threshold === "number") out.set(g.key, g.threshold);
  }
  return out;
}

interface RecordedVersion {
  protocol_version_id: string;
  content_digest: string;
  /** `failureTaxonomy` entries that named no failure mode of this plugin: a name no DISCOVER run
   *  has minted a stable key for. Reported, never refused — the relation is what a protocol's
   *  lineage IS now, so a name that folded nothing is worth seeing. */
  unfolded_taxonomy_keys: string[];
}

/** Everything `protocol_record` needs beyond the validated body: which plugin (from the caller's
 *  `subject_version_id`, resolved by `protocol.ts`), the principal id whose name the version
 *  carries as `recorded_by`, and the transaction client `withIdempotency` handed in — every write
 *  below lands in that one transaction, alongside the idempotency ledger's own insert, or none
 *  of it does. */
export async function recordProtocolVersion(
  client: pg.PoolClient, pluginId: string, body: EvaluationProtocol, recordedBy: string,
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
  const duplicateIssue = duplicateMeasureKeyRefusal(body);
  if (duplicateIssue) return `REFUSED: ${duplicateIssue}`;
  const guardrailIssue = criticalGuardrailRefusal(body);
  if (guardrailIssue) return `REFUSED: ${guardrailIssue}`;

  const evaluators = await resolveMeasureEvaluators(body);
  if (typeof evaluators === "string") return `REFUSED: ${evaluators}`;

  const maxRow = (await client.query<{ max: number | null }>(
    `select max(version) as max from zz.eval_protocol_version where plugin_id = $1::uuid`,
    [pluginId])).rows[0];
  const versionRefusal = nextVersionRefusal(body.version, maxRow?.max ?? null);
  if (versionRefusal) return versionRefusal;

  const lineage = await resolveLineage(client, pluginId, body);
  if (typeof lineage === "string") return lineage;

  const guards = guardrailsByMeasureKey(body);
  const digest = sha256Digest(canonicalJson(body));

  let versionRow: { id: string };
  try {
    versionRow = (await client.query<{ id: string }>(`
      insert into zz.eval_protocol_version
        (plugin_id, protocol_key, version, purpose, observable_surfaces, qualification_policy,
         scoring_policy, improvement_policy, content_digest, recorded_by, created_at)
      values ($1::uuid, $2, $3, $4, $5::text[], $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::uuid, now())
      returning id::text as id`,
      [pluginId, body.protocolKey, body.version, body.pluginPurpose, body.observableSurfaces,
       JSON.stringify(body.qualification), JSON.stringify(body.scoring),
       JSON.stringify(improvementPolicyOf(body.improvement)), digest, recordedBy])).rows[0];
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
        (protocol_version_id, key, canonical_kind, weight, required, applicable, not_applicable_reason)
      values ($1::uuid, $2, $3, $4, $5, $6,
              -- 001's CHECK pairs applicable/not_applicable_reason strictly: null on one side,
              -- a real string on the other. The zod schema above only requires a reason when
              -- NOT applicable; a stray one on an applicable dimension is dropped here rather
              -- than sent through to a CHECK violation the caller cannot read a message from.
              case when $6 then null else $7 end)
      returning id::text as id`,
      [protocolVersionId, dim.key, dim.canonicalKind, dim.weight, dim.required,
       dim.applicable, dim.notApplicableReason])).rows[0];
    for (const measure of dim.measures) {
      const evaluatorVersionId = evaluators.get(`${dim.key}.${measure.key}`) ?? null;
      // `fact_key` only where the biconditional allows one: a `deterministic`/`outcome` measure
      // reads a fact, a model-backed or `human` one must leave the column null, and a
      // `definition.factPath` on the wrong side of that line is a row the CHECK refuses.
      const readsAFact = measure.evaluatorType === "deterministic" || measure.evaluatorType === "outcome";
      const factPath = measure.definition.factPath;
      const subjectKind = measure.definition.subjectKind;
      await client.query(`
        insert into zz.eval_measure
          (dimension_id, protocol_version_id, key, evaluator_type, weight, required, definition,
           evaluator_version_id, fact_key, subject_kind, guardrail_threshold)
        values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::uuid, $9, $10, $11)`,
        [dimRow.id, protocolVersionId, measure.key, measure.evaluatorType, measure.weight,
         measure.required, JSON.stringify(measure.definition), evaluatorVersionId,
         readsAFact && typeof factPath === "string" && factPath.trim() ? factPath : null,
         typeof subjectKind === "string" && subjectKind.trim() ? subjectKind : null,
         guards.get(measure.key) ?? null]);
    }
  }

  await applyLineage(client, protocolVersionId, lineage.failureModeIds);

  return {
    protocol_version_id: protocolVersionId, content_digest: digest,
    unfolded_taxonomy_keys: lineage.unfoldedKeys,
  };
}
