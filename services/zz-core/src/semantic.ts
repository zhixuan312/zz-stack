/**
 * The semantic-assessment role: the bounded questions a flow's checkpoints ask, answered by the
 * typed service and recorded with their provenance.
 *
 * The nine families are `QUESTION_FAMILIES` in @zz/contracts. This file gives each one the
 * instruction the typed service is asked. Every family is a `noul` question — one probability
 * that the answer is yes — and what a checkpoint does with that probability is decided here, by
 * `readingOf`, never by the model.
 *
 * The callers that ask a family:
 *   - `source_add`, which asks `changes_commitment` about an audit round the moment it lands, so
 *     `initiative_status` can route the next move on the answer, and `repeats_finding` once per
 *     new S1/S2 finding of a review round (review-rounds.ts);
 *   - `document_write`/`document_patch` and `document_approve` on a verifying document, which ask
 *     `evidence_relation` of each established acceptance row (review-acceptance.ts);
 *   - the `assess` tool, which any stage uses to ask one family about one subject.
 *
 * Every answer is written twice, and each copy has one job:
 *   - `zz.assessment`, the provenance record: the question, the digest, the reading, and the
 *     call that produced it. Its `model_call_id` is the `zz.model_call` row the same call wrote,
 *     and a row that came from a call it cannot name is not written at all — a record claiming
 *     an attribution it does not have is worse than no record;
 *   - `<initiative>/_assessments/<source>.json` in the store, for an audit round. The next move
 *     is computed from store files, so it stays computable with no database.
 *
 * The row names a principal and a team, not the text the caller handed over: `asked_by` is the
 * principal whose email was passed, `initiative_id` the initiative that slug names, and `team_id`
 * the team the judgment belongs to — resolved the way the phase-2 migration resolved them
 * for the rows already in the table, so a row written from now on and a row the migration carried
 * agree row for row.
 *
 * Absence is an answer. With no typed-service key the reading is `unavailable`, the reason is
 * recorded, and every caller carries on with its deterministic rule alone.
 *
 * Another caller was added for plugin-eval's protocol-defined evaluators (FR-13, FR-15,
 * Task I-8): `recordEvaluatorAssessment`, called directly by a measure (e.g. `discover.ts`'s
 * ownership classification) or through `evaluators.ts`'s `askEvaluator`. Unlike a family, an
 * evaluator's question, answer shape (`noul`/`choice`/`score`), polarity and model policy are
 * not fixed in this file — they live in `zz.eval_evaluator_version`, written once when the
 * evaluator is defined, and resolved here by `evaluator_version_id`. Both callers share one
 * insert builder (`insertAssessmentRow`), so the two identity shapes (`family` xor
 * `evaluator_version_id`, enforced by 001's own check) land in one table through one
 * code path — but they keep their own error behaviour: `assessFamily`'s provenance write is
 * best-effort (an answer in hand is not lost to a database hiccup), while
 * `recordEvaluatorAssessment`'s is not — a plugin-eval measure with no recorded assessment_id is
 * a measure that silently never happened, so its insert failure is thrown, not swallowed.
 */
import { createHash } from "node:crypto";
import { QUESTION_FAMILIES } from "@zz/contracts";
import type pg from "pg";

import { ask, configured, NOT_CONFIGURED, TypedCallRefusal, type Question } from "./typed-service.js";
import { db, teamFor } from "./platform-db.js";
import { Refusal } from "./refusal.js";

/** What the typed service is asked for each family. The state it answers over always carries a
 *  SUBJECT and usually a CONTEXT; the instruction says what "yes" means about the subject. */
export const FAMILY_INSTRUCTIONS: Readonly<Record<string, string>> = Object.freeze({
  evidence_relation:
    "Does the CONTEXT passage support the claim made in the SUBJECT? Yes only if the passage " +
    "actually supports it; contradicting, unclear or unrelated is no.",
  requirement_coverage:
    "Does the SUBJECT fully cover the requirement stated in the CONTEXT? Partial coverage, " +
    "omission or an unclear answer is no.",
  needs_fact:
    "Does resolving the gap named in the SUBJECT need a fact fetched from somewhere, rather than " +
    "analysis, a verification or a decision by a person?",
  needs_verification:
    "Does resolving the gap named in the SUBJECT need something checked or verified, rather than " +
    "a fact fetched, analysis or a decision by a person?",
  needs_analysis:
    "Does resolving the gap named in the SUBJECT need analysis or reasoning over material already " +
    "available, rather than a new fact, a verification or a decision by a person?",
  missing_user_input:
    "Is an input that only the person who owns this work can supply — a preference, a scope call, " +
    "a priority, an authority — still missing from the SUBJECT?",
  changes_commitment:
    "Would acting on the SUBJECT change something the CONTEXT records as already agreed or " +
    "committed to — its scope, a decision, an acceptance criterion or a stated constraint — " +
    "rather than only clarifying, correcting or completing it?",
  repeats_finding:
    "Does the SUBJECT mostly repeat findings already reported in the CONTEXT, rather than raising " +
    "new ones or confirming that earlier findings were fixed?",
  actionability:
    "Is the repair the SUBJECT proposes specific enough to carry out without asking its author " +
    "what they meant?",
});

// A family added to the contracts with no instruction here would be a checkpoint nobody can ask.
for (const f of QUESTION_FAMILIES) {
  if (!FAMILY_INSTRUCTIONS[f]) throw new Error(`semantic family ${f} has no instruction`);
}

/** Bumped whenever an instruction's wording changes; the digest pins the exact bytes too. */
const INSTRUCTION_VERSION = 1;

export function questionDigest(family: string): string {
  return createHash("sha256").update(`${family}\n${FAMILY_INSTRUCTIONS[family] ?? ""}`)
    .digest("hex").slice(0, 16);
}

/** How a probability is read. The platform's own convention, like the 0.5 cut the typed judge
 *  uses for a threshold line: no calibrated mapping exists for these questions, so the middle
 *  band is reported as `unclear` rather than forced to a side. */
export const READING_BANDS = Object.freeze({ no_below: 0.35, yes_above: 0.65 });

export function readingOf(probability: number | null): Assessment["reading"] {
  if (probability === null || !Number.isFinite(probability)) return "unavailable";
  if (probability > READING_BANDS.yes_above) return "yes";
  if (probability < READING_BANDS.no_below) return "no";
  return "unclear";
}

export interface Assessment {
  family: string;
  instruction_version: number;
  question_digest: string;
  reading: "yes" | "no" | "unclear" | "unavailable";
  probability: number | null;
  requested_model: string | null;
  resolved_model: string | null;
  identity_assurance: string | null;
  /** Why there is no reading, when there is none. */
  reason: string | null;
  initiative: string | null;
  /** What the assessment is about: a document, a source, a finding. */
  about: string | null;
  asked_by: string;
  asked_at: string;
}

/** Enough of each part to be read and no more: the typed service answers over one state string,
 *  and a whole document plus its history is not a bounded question. */
const MAX_PART = 24_000;
const clip = (s: string) => (s.length > MAX_PART ? `${s.slice(0, MAX_PART)}\n[… truncated]` : s);

/** Whether a call was made for this assessment, and which `zz.model_call` row it wrote — the
 *  pairing `zz.assessment.model_call_id` carries. A family asked with no key has neither: nothing
 *  was requested, so nothing is named. A family whose call was refused has both, because the row
 *  that says the call happened is exactly the row that says it failed. */
interface AssessmentCall { made: boolean; model_call_id: number | null }

/** Ask one family about one subject. An unavailable service is an answer, recorded with its
 *  reason; the only refusal is a family that does not exist. */
export async function assessFamily(opts: {
  family: string; subject: string; context?: string;
  initiative?: string | null; about?: string | null; askedBy: string;
}): Promise<Assessment> {
  const { family } = opts;
  if (!FAMILY_INSTRUCTIONS[family]) {
    throw new Refusal(`ERROR: "${family}" is not a registered question family — one of ${QUESTION_FAMILIES.join(", ")}`);
  }
  const base = {
    family, instruction_version: INSTRUCTION_VERSION, question_digest: questionDigest(family),
    initiative: opts.initiative ?? null, about: opts.about ?? null,
    asked_by: opts.askedBy, asked_at: new Date().toISOString(),
  };
  // What the call was asked for, taken from the call itself rather than from the environment: the
  // request and the row that records it are then the same string by construction.
  let requested_model: string | null = null;
  let call: AssessmentCall = { made: false, model_call_id: null };
  let out: Assessment;
  if (!configured()) {
    out = { ...base, requested_model, reading: "unavailable", probability: null, resolved_model: null,
            identity_assurance: null, reason: NOT_CONFIGURED };
  } else {
    const state = (opts.context ? `CONTEXT:\n${clip(opts.context)}\n\n` : "") + `SUBJECT:\n${clip(opts.subject)}`;
    try {
      const answered = await ask(state, { [family]: { type: "noul", instructions: FAMILY_INSTRUCTIONS[family] } });
      requested_model = answered.model;
      call = { made: true, model_call_id: answered.model_call_id };
      const a = answered.answers[family];
      const p = a?.readings.probability ?? null;
      out = { ...base, requested_model, reading: readingOf(p), probability: p,
              resolved_model: a?.resolved_identity ?? null,
              identity_assurance: a?.identity_assurance ?? null, reason: null };
    } catch (err) {
      // A call that was made names itself even when it refused: the row is there, and this
      // reading is about the answer it did not give.
      if (err instanceof TypedCallRefusal) {
        requested_model = err.model;
        call = { made: true, model_call_id: err.model_call_id };
      }
      out = { ...base, requested_model, reading: "unavailable", probability: null, resolved_model: null,
              identity_assurance: null,
              reason: err instanceof Error ? err.message.replace(/^ERROR:\s*/, "").slice(0, 300) : String(err) };
    }
  }
  await persistAssessment(out, call);
  return out;
}

/** One `zz.assessment` row, in the shape the table itself declares (001, reshaped by
 *  the phase-2 migration): a family question xor an evaluator question, and only a
 *  `choice`/`score` answer ever carries a `distribution`. Building it in one place is what keeps
 *  `assessFamily` and `recordEvaluatorAssessment` writing rows the table's own checks agree on.
 *
 *  The four columns that name somebody else are not here: `asked_by`, `team_id` and
 *  `initiative_id` are resolved by the insert from `asked_by` the email and `initiative` the slug,
 *  because a caller holding a person's address has no principal id to pass — and a caller that
 *  passed one anyway could pass the wrong one.
 *
 *  `team`, the one exception, is resolved by whoever holds the identity, in the same breath as
 *  `asked_by` and for the same reason: `insertEvaluatorAnswer` writes inside a mutator's own
 *  transaction, and a team lookup from in there would ride a second pool connection to do it. The
 *  platform's own note on that is `evaluate.ts`'s — a transaction held across a long call pins a
 *  pool connection — and this insert is the half that must never need one. */
interface AssessmentInsertRow {
  family: string | null;
  evaluator_version_id: string | null;
  instruction_version: number;
  question_digest: string;
  reading: Assessment["reading"] | null;
  probability: number | null;
  distribution: Readonly<Record<string, number>> | null;
  answer_kind: "noul" | "choice" | "score";
  resolved_model: string | null;
  identity_assurance: string | null;
  reason: string | null;
  /** The call this answer came from. `made` with no id is refused by the insert below. */
  call_made: boolean;
  model_call_id: number | null;
  /** The initiative's slug, as the asker named it. Resolved to a row by the insert. */
  initiative: string | null;
  about: string | null;
  /** The asker's address. Resolved to a principal by the insert. */
  asked_by: string;
  asked_at: string;
  /** The team the asker acts for, by slug — `teamFor`'s answer, taken where the call was made. */
  team: string | null;
}

/** The one insert both callers share. Returns the new row's id — `recordEvaluatorAssessment`
 *  needs it for `assessment_id`; `assessFamily`'s `Assessment` has never carried one and does
 *  not start now. Throws on any failure: whether that is swallowed or not is each caller's own
 *  call, made where it decides what a failure means for it.
 *
 *  DELIBERATE: a row that came from a call and cannot name it is refused rather than written
 *  with the column null. The platform's rule is that a record claiming an attribution it does
 *  not have is worse than no record, and a null `model_call_id` says the opposite of what
 *  happened — that no call was made. An address no principal carries throws for the same reason:
 *  there is nobody to attribute the judgment to, and nothing here may invent one.
 *
 *  The three names are resolved here from the email and the slug the row carries, so a row written
 *  from now on and a row the migration carried agree about who asked and which initiative it was:
 *  `asked_by` is the principal whose address this is; `initiative_id` is the initiative that slug
 *  names — the asker's team's preferred, and otherwise the only one that has it, so a slug two
 *  teams share resolves to the asker's own or to nothing; and `team_id` is that initiative's team,
 *  or the asker's own acting team where the slug resolved nothing.
 *
 *  A person who acts for no team at all is refused for the same reason as an address nobody
 *  carries: `team_id` is `not null`, and the platform does not invent an attribution.
 *
 *  DELIBERATE, and where I-19's own rule stops short: that rule named `principal.active_team_id`
 *  as the team to fall back on, and the column is not the answer. `team_switch` is its only writer
 *  on the whole platform, so a person onboarded and never switched holds null there while their
 *  work acts for the team their membership gives them — and an evaluator question carries no
 *  initiative, so nothing else could name a team either. `team_id` is `not null`, so the row was
 *  refused by the database: the eval-flow walk reached it, and `failure_discover` answered with
 *  Postgres's own sentence rather than a refusal of the platform's own. The column the row wants is
 *  `teamFor`'s answer — a bound token's team, the console session's team, the team they chose while
 *  it is still a live membership, and otherwise their admin team then the alphabetically first —
 *  which is `actingTeam` in @zz/contracts, the same rule every other caller resolves through. */
async function insertAssessmentRow(row: AssessmentInsertRow, runner?: Queryable): Promise<number> {
  const p = runner ?? db();
  if (!p) throw new Error("no platform database configured");
  if (row.call_made && row.model_call_id === null) {
    throw new Error("this assessment came from a typed call that wrote no zz.model_call row, so " +
                    "it cannot name the call that produced it");
  }
  const email = row.asked_by;
  const slug = row.initiative;
  const team = row.team;
  const { rows } = await p.query<{ id: string }>(`
    with asker as (
      -- $15. One row: an address two principals share is a database already broken, and an
      -- assessment names one person. A deactivated principal is still found here — they are a real
      -- person who really asked — and the team resolved above then finds them none, which is the
      -- refusal this row wants rather than a claim that nobody carries the address.
      select p.id
        from zz.principal p
       where lower(p.email) = lower($15)
       limit 1
    ), act as (
      -- $17. That team, by slug, as an id. Empty when they act for none, which writes no row.
      select t.id from zz.team t where t.slug = $17 and t.status = 'active'
    ), target as (
      -- $16. The initiative the slug names, by the migration's own rule — the asker's team's
      -- where there is one, and otherwise the only initiative that has the slug at all.
      select i.id, i.team_id
        from zz.initiative i
       where i.slug = $16
         and (i.team_id = (select id from act)
              or (select count(*) from zz.initiative j where j.slug = $16) = 1)
       order by (i.team_id = (select id from act)) desc
       limit 1
    )
    insert into zz.assessment
      (family, evaluator_version_id, instruction_version, question_digest, reading, probability,
       distribution, answer_kind, resolved_model, identity_assurance, reason,
       model_call_id, about, asked_at, asked_by, team_id, initiative_id)
    select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
           a.id, coalesce((select team_id from target), (select id from act)), (select id from target)
      from asker a
     where coalesce((select team_id from target), (select id from act)) is not null
    returning id`,
    [row.family, row.evaluator_version_id, row.instruction_version, row.question_digest,
     row.reading, row.probability, row.distribution ? JSON.stringify(row.distribution) : null,
     row.answer_kind, row.resolved_model, row.identity_assurance,
     row.reason, row.model_call_id, row.about, row.asked_at, email, slug, team]);
  const id = rows[0]?.id;
  if (id === undefined) {
    // Which of the three the insert declined on, read only on the path that wrote nothing. The
    // last is a window rather than a state — the asker's last live team went between the write and
    // this read — so it is named as the race it is instead of guessed at as a fault.
    const { rows: why } = await p.query<{ who: string }>(`
      select case
        when not exists (select 1 from zz.principal q where lower(q.email) = lower($1))
          then 'nobody'
        when not exists (select 1 from zz.membership m
                           join zz.team t on t.id = m.team_id
                           join zz.principal q on q.id = m.principal_id
                          where lower(q.email) = lower($1) and q.status = 'active'
                            and t.status = 'active')
          then 'no_team'
        else 'changed' end as who`, [email]);
    switch (why[0]?.who) {
      case "no_team":
        throw new Error(`"${email}" acts for no live team, so this assessment cannot name one — ` +
                        "the platform will not invent an attribution it does not have. Nothing " +
                        "was written.");
      case "changed":
        throw new Error(`the team this assessment would name is not one "${email}" acts for — it ` +
                        "changed between resolving it and writing the row, or the credential " +
                        "making the call names a team they are not in. Nothing was written; ask " +
                        "again.");
      default:
        throw new Error(`no zz.principal carries the address "${email}", so this assessment ` +
                        "cannot say who asked for it. Nothing was written.");
    }
  }
  return Number(id);
}

/** The provenance row for a family question. Never throws: an answer in hand is not lost to a
 *  database hiccup — the store copy under `_assessments/` is the one the next move reads. */
async function persistAssessment(a: Assessment, call: AssessmentCall): Promise<void> {
  try {
    await insertAssessmentRow({
      family: a.family, evaluator_version_id: null, instruction_version: a.instruction_version,
      question_digest: a.question_digest, reading: a.reading, probability: a.probability,
      distribution: null, answer_kind: "noul",
      resolved_model: a.resolved_model, identity_assurance: a.identity_assurance,
      reason: a.reason, call_made: call.made, model_call_id: call.model_call_id,
      initiative: a.initiative, about: a.about, asked_by: a.asked_by, asked_at: a.asked_at,
      // Asked here and carried in, not resolved by the insert: see `AssessmentInsertRow.team`.
      team: await teamFor(a.asked_by),
    });
  } catch { /* the store copy is the one the next move reads */ }
}

/** `zz.eval_evaluator_version` as `recordEvaluatorAssessment` needs to read it: the exact row
 *  a `bounded_semantic`/`generative_critic` measure resolved to, with its stable identity. The
 *  stable key lives on this row now — `zz.eval_evaluator` was a header carrying nothing but the
 *  key and a `kind` nothing read, and the phase-3 migration folded it onto the version. */
interface EvaluatorVersionRow {
  id: string;
  version: number;
  question: string;
  /** One of `typed-service.ts`'s three `Question` shapes, minus `instructions` — the evaluator's
   *  own `question` column supplies that. `type` is validated against `EVAL_STATE_ENUMS.answerKind`
   *  wherever a version is written (`evaluators.ts`'s `registerEvaluator`), so reading it back here
   *  is a lookup, not a second validation. */
  answer_schema: { type: "noul" } | { type: "choice"; criteria: Record<string, string> } |
                 { type: "score"; criteria: string[] };
  stable_key: string;
}

const EVALUATOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The plan header's formula: the first 16 hex characters of sha256 over the evaluator's stable
 *  key, its version, and the exact question text — pinning the wording the same way a family's
 *  `questionDigest` pins its instruction, but keyed to a version rather than to a static map. */
export function evaluatorQuestionDigest(stableKey: string, version: number, question: string): string {
  return createHash("sha256").update(`${stableKey}\n${version}\n${question}`).digest("hex").slice(0, 16);
}

async function resolveEvaluatorVersion(evaluatorVersionId: string): Promise<EvaluatorVersionRow> {
  const p = db();
  if (!p) throw new Refusal("ERROR: this deployment has no platform database, so no evaluator can be resolved");
  // A malformed id is refused the same way an unknown one is, rather than reaching Postgres and
  // surfacing its own "invalid input syntax for type uuid" instead of this contract's text.
  if (!EVALUATOR_UUID_RE.test(evaluatorVersionId)) {
    throw new Refusal(`ERROR: "${evaluatorVersionId}" is not a registered evaluator version`);
  }
  const { rows } = await p.query<EvaluatorVersionRow>(`
    select v.id, v.version, v.question, v.answer_schema, v.stable_key
      from zz.eval_evaluator_version v
     where v.id = $1::uuid`, [evaluatorVersionId]);
  const row = rows[0];
  if (!row) throw new Refusal(`ERROR: "${evaluatorVersionId}" is not a registered evaluator version`);
  return row;
}

/** What `recordEvaluatorAssessment` hands back: exactly the plan header's response shape, plus
 *  `reason` (Task I-9) — the same "why there is no reading" text `Assessment.reason` already
 *  carries for a family question, previously computed here and dropped on the way out. A caller
 *  that must persist an `unavailable` classification with its own cause (`discover.ts`'s "a
 *  model outage stores owner_kind='unknown' with a reason, never dropped") cannot write a reason
 *  it was never handed. A caller that must carry the call forward (`evaluate-measures.ts` puts it
 *  in the measure's own answer) cannot write an id it was never handed either. */
export interface EvaluatorAssessmentResult {
  assessment_id: number;
  /** The `zz.model_call` row this answer came from — written on the assessment in the same
   *  insert, and null only when no call was made at all (no typed service configured). */
  model_call_id: number | null;
  answer_kind: "noul" | "choice" | "score";
  probability: number | null;
  distribution: Readonly<Record<string, number>> | null;
  reading: Assessment["reading"] | null;
  resolved_model: string | null;
  identity_assurance: string | null;
  reason: string | null;
}

/** One evaluator answer the typed service has given and nothing has recorded yet — what
 *  `askEvaluatorQuestion` hands back and `insertEvaluatorAnswer` writes. Split so a mutator can
 *  ask BEFORE it opens its idempotency transaction (a typed-service call can take ~100s, and a
 *  transaction held open across it pins one of the pool's few connections) and record INSIDE it
 *  (so the `zz.assessment` row commits or rolls back with the ledger row, and a replay never
 *  writes a second one). */
export interface AskedEvaluatorAnswer {
  readonly row: AssessmentInsertRow;
  readonly result: Omit<EvaluatorAssessmentResult, "assessment_id">;
}

/** Anything `insertEvaluatorAnswer` can write through: the pool, or a client inside a
 *  transaction. */
interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Ask one registered evaluator question about one subject — no write.
 *
 * "Every model-backed measure resolves to a `zz.eval_evaluator_version`": the resolve happens
 * here, first, and an `evaluator_version_id` nothing registered is refused before any model is
 * asked. The primitive the typed service is asked (`noul`/`choice`/`score`) is the evaluator's
 * own declared shape, never the caller's choice. */
export async function askEvaluatorQuestion(opts: {
  evaluator_version_id: string; subject_text: string; context?: string; askedBy: string;
}): Promise<AskedEvaluatorAnswer> {
  const evaluator = await resolveEvaluatorVersion(opts.evaluator_version_id);
  const digest = evaluatorQuestionDigest(evaluator.stable_key, evaluator.version, evaluator.question);
  const asked_at = new Date().toISOString();

  let reading: Assessment["reading"] | null = null;
  let probability: number | null = null;
  let distribution: Readonly<Record<string, number>> | null = null;
  let resolved_model: string | null = null;
  let identity_assurance: string | null = null;
  let reason: string | null = null;
  let model_call_id: number | null = null;
  let call_made = false;

  if (!configured()) {
    reading = "unavailable";
    reason = NOT_CONFIGURED;
  } else {
    // From here on a call was attempted, whether or not it answered: the row that records it is
    // what this assessment is paired with, and an unanswered call is still evidence.
    call_made = true;
    const state = (opts.context ? `CONTEXT:\n${clip(opts.context)}\n\n` : "") +
      `SUBJECT:\n${clip(opts.subject_text)}`;
    const schema = evaluator.answer_schema;
    const question: Question = schema.type === "noul"
      ? { type: "noul", instructions: evaluator.question }
      : schema.type === "score"
      ? { type: "score", instructions: evaluator.question, criteria: schema.criteria }
      : { type: "choice", instructions: evaluator.question, criteria: schema.criteria };
    try {
      const answered = await ask(state, { q: question });
      model_call_id = answered.model_call_id;
      const a = answered.answers.q;
      resolved_model = a?.resolved_identity ?? null;
      identity_assurance = a?.identity_assurance ?? null;
      if (schema.type === "noul") {
        probability = a?.readings.probability ?? null;
        reading = readingOf(probability);
      } else if (schema.type === "score") {
        // The adapter's own asymmetry: a score's per-level probabilities are read straight off
        // `readings.distribution` (`jev-reply.ts`'s `translate` sets it directly from the
        // reply's `probabilities`, independent of the port's signal system).
        distribution = a?.readings.distribution ?? null;
      } else {
        // A choice's distribution never reaches `readings.distribution` — that field is
        // score-only in this adapter. It arrives as the port's own `native_distribution`
        // signal instead (`assessment.ts`'s `readSignals`, from the same `probabilities` field
        // the reply sent for a category answer).
        distribution = (a?.signals.find((s) => s.name === "distribution")?.values as
          Readonly<Record<string, number>> | undefined) ?? null;
      }
      if (schema.type !== "noul" && !distribution) {
        reading = "unavailable";
        reason = "the typed service answered with no distribution over this question's declared options";
      }
    } catch (err) {
      if (err instanceof TypedCallRefusal) model_call_id = err.model_call_id;
      reading = "unavailable";
      reason = err instanceof Error ? err.message.replace(/^ERROR:\s*/, "").slice(0, 300) : String(err);
    }
  }

  return {
    row: {
      family: null, evaluator_version_id: evaluator.id, instruction_version: evaluator.version,
      question_digest: digest, reading, probability, distribution, answer_kind: evaluator.answer_schema.type,
      resolved_model, identity_assurance, reason, call_made, model_call_id,
      initiative: null, about: null, asked_by: opts.askedBy, asked_at,
      // Asked here, on the pool, rather than inside the insert: a mutator records this row through
      // its own transaction client, and the insert must not reach for a connection of its own.
      team: await teamFor(opts.askedBy),
    },
    result: {
      answer_kind: evaluator.answer_schema.type, probability, distribution, reading,
      resolved_model, identity_assurance, reason, model_call_id,
    },
  };
}

/** Record one asked answer through `runner` — the caller's own transaction client when the
 *  answer belongs to a mutator's ledger write. Not wrapped in a swallowing `catch`: a plugin-eval
 *  measure with no `assessment_id` is a measure that silently never happened, and
 *  `zz.eval_assessment` cannot reference a row that was never written. */
export async function insertEvaluatorAnswer(
  runner: Queryable, asked: AskedEvaluatorAnswer,
): Promise<EvaluatorAssessmentResult> {
  const assessment_id = await insertAssessmentRow(asked.row, runner);
  return { assessment_id, ...asked.result };
}

/** Ask and record in one go, on the pool — for a caller that holds no transaction of its own
 *  (`evaluators.ts`'s `askEvaluator`, `qualify-evidence.ts`). A mutator asks with
 *  `askEvaluatorQuestion` before its transaction and records with `insertEvaluatorAnswer` inside
 *  it instead. */
export async function recordEvaluatorAssessment(opts: {
  evaluator_version_id: string; subject_text: string; context?: string; askedBy: string;
}): Promise<EvaluatorAssessmentResult> {
  const asked = await askEvaluatorQuestion(opts);
  const p = db();
  if (!p) throw new Error("no platform database configured");
  return insertEvaluatorAnswer(p, asked);
}

// DELIBERATE: the three functions that lived here — `writeRoundAssessments`,
// `readRoundAssessmentList` and `readRoundAssessments` — are DELETED, not converted.
//
// They wrote and read `<initiative>/_assessments/<source>.json`, and `assessFamily` above persists
// every answer as a `zz.assessment` row the moment it takes it. The file was therefore a SECOND
// copy of a record that already existed, and the spec's store-migration paragraph names
// `_assessments/*.json` as one of the four per-initiative JSON state files that "are already in
// tables and are verified, not copied" — this is the last of the four to become true.
//
// Their two callers (`review-rounds.ts`'s `assessReviewRound`, `audit-rounds.ts`'s `assessRound`)
// already read the rows back through `assessmentsFor`, so nothing calls these any more: converting
// them would have been writing code with no caller. The carry that read those files is gone with
// the store it read, and the claim it used to check — every file's `question_digest` has a
// matching row — is now the only record there is: the rows are what an assessment IS.

