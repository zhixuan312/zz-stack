/**
 * The evaluator registry (FR-13, FR-15, Task I-8): durable identities and versions for
 * plugin-eval's bounded-semantic and generative-critic questions, and `askEvaluator`, the one
 * call a measure makes to get a typed answer recorded against one.
 *
 * Two tables, two lifetimes:
 *   - `zz.eval_evaluator` — one row per `stable_key`, forever. `kind` (`noul`/`choice`/`score`)
 *     is the evaluator's own identity and does not move between versions.
 *   - `zz.eval_evaluator_version` — the frozen question/answer-schema/polarity/model-policy an
 *     assessment actually resolves to, keyed by `content_digest` so registering the same
 *     definition twice reuses the version rather than minting a new one on every call.
 *
 * `registerEvaluator` is the only writer of either table. A caller — `discover.ts`'s ownership
 * classification (Task I-9) is the first one — defines its evaluator once, in code, and calls
 * this at the point it needs an `evaluator_version_id`; there is no separate seeding step and no
 * fixed list here, because which evaluators exist is each measure's own business, not this
 * registry's (see the plan's own boundary: final deliverable content is not in this plan).
 *
 * `askEvaluator` does no resolving of its own: it is the positional wrapper the plan header
 * names, over `recordEvaluatorAssessment` in `../semantic.ts`, which is where "an
 * `evaluator_version_id` nothing registered is refused" and the typed-service call actually
 * happen — one place, shared with `assessFamily`'s insert path. `discover.ts` (Task I-9) calls
 * `recordEvaluatorAssessment` directly for the same reason a caller already holding an id has no
 * need to go through this wrapper.
 */
import { createHash } from "node:crypto";

import { EVAL_STATE_ENUMS } from "@zz/contracts";
import type pg from "pg";

import { canonicalJson } from "./idempotency.js";
import { recordEvaluatorAssessment, type EvaluatorAssessmentResult } from "../semantic.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

export type { EvaluatorAssessmentResult };

const ANSWER_KINDS = EVAL_STATE_ENUMS.answerKind;
type AnswerKind = (typeof ANSWER_KINDS)[number];

/** The three shapes an evaluator's answer may take — the same vocabulary `typed-service.ts`'s
 *  `Question` type uses, minus `instructions`: the version's own `question` column supplies
 *  that, so the same instruction text is never stored twice. */
export type EvaluatorAnswerSchema =
  | { readonly type: "noul" }
  | { readonly type: "choice"; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly criteria: readonly string[] };

/** What a caller hands `registerEvaluator`: everything 001's `zz.eval_evaluator` and
 *  `zz.eval_evaluator_version` need to exist, before any question has been asked. */
export interface EvaluatorDefinition {
  readonly stable_key: string;
  readonly kind: AnswerKind;
  readonly question: string;
  readonly answer_schema: EvaluatorAnswerSchema;
  /** How the answer is meant, e.g. which side of a predicate counts as a finding — content this
   *  registry stores and never reads. */
  readonly polarity: Readonly<Record<string, unknown>>;
  /** Model routing/qualification metadata (e.g. a pinned identity) — stored and never read here;
   *  `evaluator_qualify` (Task I-11) is what reads it back. */
  readonly model_policy: Readonly<Record<string, unknown>>;
}

function noDb(): Refusal {
  return new Refusal("ERROR: this deployment has no platform database, so no evaluator can be registered");
}

// Postgres's own code for "unique_violation" — see idempotency.ts's own use of this constant for
// the same race: two callers registering the same new version at once.
const UNIQUE_VIOLATION = "23505";

/** Register (or reuse) one evaluator version, and return the id `askEvaluator`/
 *  `recordEvaluatorAssessment` resolve. Idempotent by content: registering the exact same
 *  definition again returns the same `evaluator_version_id` rather than minting a duplicate, so
 *  a measure may call this on every run with no separate "already registered?" check of its own.
 *
 *  Refuses a `kind`/`answer_schema.type` mismatch and a `stable_key` re-registered under a
 *  different `kind` — an evaluator's `kind` is its identity, not a per-version choice. */
export async function registerEvaluator(
  def: EvaluatorDefinition,
): Promise<{ evaluator_version_id: string; version: number }> {
  if (!ANSWER_KINDS.includes(def.kind)) {
    throw new Refusal(`ERROR: "${def.kind}" is not a registered answer kind — one of ${ANSWER_KINDS.join(", ")}`);
  }
  if (def.answer_schema.type !== def.kind) {
    throw new Refusal(
      `ERROR: evaluator "${def.stable_key}" declares kind "${def.kind}" but its answer_schema is ` +
      `"${def.answer_schema.type}"`);
  }
  const p = db();
  if (!p) throw noDb();

  // Atomic upsert-and-read-back: a no-op update on conflict still returns the row, whether this
  // call just created it or an earlier one did, so the kind check below sees the identity's real
  // (unchanged) kind rather than racing a separate select against a separate insert.
  const evaluator = await p.query<{ id: string; kind: string }>(`
    insert into zz.eval_evaluator (stable_key, kind) values ($1, $2)
    on conflict (stable_key) do update set kind = zz.eval_evaluator.kind
    returning id, kind`,
    [def.stable_key, def.kind]);
  const row = evaluator.rows[0];
  if (!row) throw new Error(`upsert into zz.eval_evaluator produced no row for "${def.stable_key}"`);
  if (row.kind !== def.kind) {
    throw new Refusal(
      `ERROR: evaluator "${def.stable_key}" is already registered as kind "${row.kind}", not "${def.kind}"`);
  }
  const evaluatorId = row.id;

  const digest = createHash("sha256").update(canonicalJson({
    question: def.question, answer_schema: def.answer_schema,
    polarity: def.polarity, model_policy: def.model_policy,
  })).digest("hex");

  return await registerVersion(p, evaluatorId, def, digest);
}

async function reuseVersion(
  p: Pick<pg.Pool, "query">, evaluatorId: string, digest: string,
): Promise<{ evaluator_version_id: string; version: number } | null> {
  const { rows } = await p.query<{ id: string; version: number }>(
    `select id, version from zz.eval_evaluator_version where evaluator_id = $1 and content_digest = $2`,
    [evaluatorId, digest]);
  const row = rows[0];
  return row ? { evaluator_version_id: row.id, version: row.version } : null;
}

async function registerVersion(
  p: pg.Pool, evaluatorId: string, def: EvaluatorDefinition, digest: string,
): Promise<{ evaluator_version_id: string; version: number }> {
  const reused = await reuseVersion(p, evaluatorId, digest);
  if (reused) return reused;

  const { rows: maxRows } = await p.query<{ max: number | null }>(
    `select max(version) as max from zz.eval_evaluator_version where evaluator_id = $1`, [evaluatorId]);
  const version = Number(maxRows[0]?.max ?? 0) + 1;

  try {
    const { rows } = await p.query<{ id: string }>(`
      insert into zz.eval_evaluator_version
        (evaluator_id, version, question, answer_schema, polarity, model_policy, content_digest)
      values ($1,$2,$3,$4,$5,$6,$7)
      returning id`,
      [evaluatorId, version, def.question, JSON.stringify(def.answer_schema),
       JSON.stringify(def.polarity), JSON.stringify(def.model_policy), digest]);
    const id = rows[0]?.id;
    if (!id) throw new Error("insert into zz.eval_evaluator_version produced no row id");
    return { evaluator_version_id: id, version };
  } catch (err) {
    // Lost the race: a concurrent registration of the same evaluator took this version number
    // first. Re-read by content digest — if it is the twin that beat us, this is a reuse, not a
    // failure; a genuine schema violation still propagates.
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      const winner = await reuseVersion(p, evaluatorId, digest);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * The plan header's public call: ask one registered evaluator version about one subject, from
 * one principal. A thin positional wrapper — the resolving, the typed-service call and the
 * insert (never swallowed on failure) are `recordEvaluatorAssessment`'s, in `../semantic.ts`,
 * shared with `assessFamily`'s insert path.
 */
export async function askEvaluator(
  evaluator_version_id: string, subject_text: string, context: string | undefined, principal: string,
): Promise<EvaluatorAssessmentResult> {
  return recordEvaluatorAssessment({ evaluator_version_id, subject_text, context, askedBy: principal });
}
