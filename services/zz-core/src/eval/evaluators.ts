/**
 * The evaluator registry (FR-13, FR-15, Task I-8; one table since Task I-23): durable versions for
 * plugin-eval's bounded-semantic and generative-critic questions. Asking one is `semantic.ts`'s
 * `askEvaluatorQuestion`, and recording the answer its `insertEvaluatorAnswer`.
 *
 * One table, two lifetimes folded into one row:
 *   - `zz.eval_evaluator` — one row per `stable_key`, forever — is gone. Its `kind`
 *     (`noul`/`choice`/`score`) was never read by anything, and the phase-3 migration moved the
 *     key onto the version, where it is the evaluator's identity: `unique (stable_key, version)`
 *     is what a later version is the next one of.
 *   - `zz.eval_evaluator_version` — the frozen question/answer-schema/positive-answer a measure
 *     actually resolves to, keyed by `content_digest` so registering the same definition twice
 *     reuses the version rather than minting a new one on every call. `polarity` jsonb is the one
 *     answer that counts as positive (`positive_answer`, read by the reducer) and `model_policy`
 *     has no column in the target shape at all.
 *
 * `registerEvaluator` is the only writer. Its two callers are `discover.ts`, which defines its
 * ownership classification once, in code, and `protocol-record.ts`, which registers the evaluator
 * every model-backed measure of a recorded protocol names, inside the recording's transaction.
 * There is no separate seeding step and no fixed list here: which evaluators exist is each
 * measure's own business, not this registry's.
 */
import { createHash } from "node:crypto";

import { EVAL_STATE_ENUMS } from "@zz/contracts";
import type pg from "pg";

import { canonicalJson } from "./idempotency.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const ANSWER_KINDS = EVAL_STATE_ENUMS.answerKind;
type AnswerKind = (typeof ANSWER_KINDS)[number];

/** The three shapes an evaluator's answer may take — the same vocabulary `typed-service.ts`'s
 *  `Question` type uses, minus `instructions`: the version's own `question` column supplies
 *  that, so the same instruction text is never stored twice. */
export type EvaluatorAnswerSchema =
  | { readonly type: "noul" }
  | { readonly type: "choice"; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly criteria: readonly string[] };

/** What a caller hands `registerEvaluator`: everything the evaluator version needs to exist,
 *  before any question has been asked.
 *
 *  `polarity` is the caller's own shape for "how the answer is meant"; the one fact the version
 *  stores is `good_when`, the single answer that counts as positive (`positive_answer`, spec item
 *  33). `model_policy` is carried for the callers that still declare it (a measure's evaluator
 *  object in `protocol_body`, and `checks/eval-evaluators.ts`'s own type sample) and has no
 *  column in the target shape: the phase-3 migration drops it, and it is no longer part of the
 *  content digest — a digest over a fact no row carries would mint two versions that differ in
 *  nothing. */
export interface EvaluatorDefinition {
  readonly stable_key: string;
  readonly kind: AnswerKind;
  readonly question: string;
  readonly answer_schema: EvaluatorAnswerSchema;
  readonly polarity: Readonly<Record<string, unknown>>;
  readonly model_policy: Readonly<Record<string, unknown>>;
}

/** The one answer that counts as positive, from the caller's `polarity` — `good_when`, as the
 *  migration reads it (`polarity->>'good_when'`). `null` when none is named: an evaluator may
 *  declare no positive side, and a made-up one is worse than an absent one. */
function positiveAnswerOf(polarity: Readonly<Record<string, unknown>>): string | null {
  const good = polarity.good_when;
  return typeof good === "string" && good.length ? good : null;
}

function noDb(): Refusal {
  return new Refusal("ERROR: this deployment has no platform database, so no evaluator can be registered");
}

/** Where an evaluator version is read and written: the platform pool, or the transaction a
 *  mutator is already in, so a refusal later in that call takes the version back with it. */
type Runner = Pick<pg.Pool, "query">;

/** Register (or reuse) one evaluator version through `runner`, and return the id
 *  `askEvaluatorQuestion` resolves. Idempotent by content: registering the exact same
 *  definition again returns the same `evaluator_version_id` rather than minting a duplicate, so
 *  a measure may call this on every run with no separate "already registered?" check of its own.
 *
 *  Refuses a `kind`/`answer_schema.type` mismatch, and a `stable_key` whose existing versions
 *  were registered under a different `answer_schema.type` — an evaluator's kind is its identity,
 *  not a per-version choice, and the version's own `answer_schema` is the only place it is
 *  recorded now that `zz.eval_evaluator` is gone. */
export async function registerEvaluator(
  def: EvaluatorDefinition, runner: Runner | null = db(),
): Promise<{ evaluator_version_id: string; version: number }> {
  if (!ANSWER_KINDS.includes(def.kind)) {
    throw new Refusal(`ERROR: "${def.kind}" is not a registered answer kind — one of ${ANSWER_KINDS.join(", ")}`);
  }
  if (def.answer_schema.type !== def.kind) {
    throw new Refusal(
      `ERROR: evaluator "${def.stable_key}" declares kind "${def.kind}" but its answer_schema is ` +
      `"${def.answer_schema.type}"`);
  }
  const p = runner;
  if (!p) throw noDb();

  // The identity's kind, read off the newest version it already has: an evaluator answers one
  // shape of question for its whole life, and a re-registration under a different one is a new
  // evaluator wearing an old key.
  const prior = (await p.query<{ kind: string | null }>(`
    select answer_schema->>'type' as kind from zz.eval_evaluator_version
     where stable_key = $1 order by version desc limit 1`, [def.stable_key])).rows[0];
  if (prior?.kind && prior.kind !== def.kind) {
    throw new Refusal(
      `ERROR: evaluator "${def.stable_key}" is already registered as kind "${prior.kind}", not "${def.kind}"`);
  }

  const positive_answer = positiveAnswerOf(def.polarity);
  const digest = createHash("sha256").update(canonicalJson({
    question: def.question, answer_schema: def.answer_schema, positive_answer,
  })).digest("hex");

  return await registerVersion(p, def, positive_answer, digest);
}

async function reuseVersion(
  p: Runner, stableKey: string, digest: string,
): Promise<{ evaluator_version_id: string; version: number } | null> {
  const { rows } = await p.query<{ id: string; version: number }>(
    `select id, version from zz.eval_evaluator_version where stable_key = $1 and content_digest = $2`,
    [stableKey, digest]);
  const row = rows[0];
  return row ? { evaluator_version_id: row.id, version: row.version } : null;
}

async function registerVersion(
  p: Runner, def: EvaluatorDefinition, positiveAnswer: string | null, digest: string,
): Promise<{ evaluator_version_id: string; version: number }> {
  const reused = await reuseVersion(p, def.stable_key, digest);
  if (reused) return reused;

  const { rows: maxRows } = await p.query<{ max: number | null }>(
    `select max(version) as max from zz.eval_evaluator_version where stable_key = $1`, [def.stable_key]);
  const version = Number(maxRows[0]?.max ?? 0) + 1;

  // `on conflict do nothing` rather than catching the unique violation: inside a caller's
  // transaction a raised violation would abort it. No row back means a concurrent registration
  // took this version number or this content first — its twin is a reuse; anything else is
  // another evaluator that won the number, and the caller is told to try again.
  const { rows } = await p.query<{ id: string }>(`
    insert into zz.eval_evaluator_version
      (stable_key, version, question, answer_schema, positive_answer, content_digest)
    values ($1,$2,$3,$4,$5,$6)
    on conflict do nothing
    returning id`,
    [def.stable_key, version, def.question, JSON.stringify(def.answer_schema),
     positiveAnswer, digest]);
  const id = rows[0]?.id;
  if (id) return { evaluator_version_id: id, version };
  const winner = await reuseVersion(p, def.stable_key, digest);
  if (winner) return winner;
  throw new Refusal(
    `REFUSED: version ${version} of evaluator "${def.stable_key}" was just registered by another call — try again`);
}
