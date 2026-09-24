/**
 * The semantic-assessment role: the bounded questions a flow's checkpoints ask, answered by the
 * typed service and recorded with their provenance.
 *
 * The nine families are `QUESTION_FAMILIES` in @zz/contracts. This file gives each one the
 * instruction the typed service is asked. Every family is a `noul` question — one probability
 * that the answer is yes — and what a checkpoint does with that probability is decided here, by
 * `readingOf`, never by the model.
 *
 * Two callers:
 *   - `source_add`, which asks `changes_commitment` and `repeats_finding` about an audit round the
 *     moment it lands, so `initiative_status` can route the next move on the answer;
 *   - the `assess` tool, which any stage uses to ask one family about one subject.
 *
 * Every answer is written twice, and each copy has one job:
 *   - `zz.assessment`, the provenance record: question, digest, requested and resolved model,
 *     identity assurance, probability, and the reading;
 *   - `<initiative>/_assessments/<source>.json` in the store, for an audit round. The next move
 *     is computed from store files, so it stays computable with no database.
 *
 * Absence is an answer. With no typed-service key the reading is `unavailable`, the reason is
 * recorded, and every caller carries on with its deterministic rule alone.
 *
 * A third caller was added for plugin-eval's protocol-defined evaluators (FR-13, FR-15,
 * Task I-8): `recordEvaluatorAssessment`, called directly by a measure (e.g. `discover.ts`'s
 * ownership classification) or through `evaluators.ts`'s `askEvaluator`. Unlike a family, an
 * evaluator's question, answer shape (`noul`/`choice`/`score`), polarity and model policy are
 * not fixed in this file — they live in `zz.eval_evaluator_version`, written once when the
 * evaluator is defined, and resolved here by `evaluator_version_id`. Both callers share one
 * insert builder (`insertAssessmentRow`), so the two identity shapes (`family` xor
 * `evaluator_version_id`, enforced by migration 077's own check) land in one table through one
 * code path — but they keep their own error behaviour: `assessFamily`'s provenance write is
 * best-effort (an answer in hand is not lost to a database hiccup), while
 * `recordEvaluatorAssessment`'s is not — a plugin-eval measure with no recorded assessment_id is
 * a measure that silently never happened, so its insert failure is thrown, not swallowed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { QUESTION_FAMILIES } from "@zz/contracts";

import { ask, configured, NOT_CONFIGURED, type Question } from "./typed-service.js";
import { db } from "./platform-db.js";
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
    requested_model: configured() ? `typesafe/${(process.env.TYPESAFE_MODEL || "jev-latest").trim()}` : null,
    initiative: opts.initiative ?? null, about: opts.about ?? null,
    asked_by: opts.askedBy, asked_at: new Date().toISOString(),
  };
  let out: Assessment;
  if (!configured()) {
    out = { ...base, reading: "unavailable", probability: null, resolved_model: null,
            identity_assurance: null, reason: NOT_CONFIGURED };
  } else {
    const state = (opts.context ? `CONTEXT:\n${clip(opts.context)}\n\n` : "") + `SUBJECT:\n${clip(opts.subject)}`;
    try {
      const answers = await ask(state, { [family]: { type: "noul", instructions: FAMILY_INSTRUCTIONS[family] } });
      const a = answers[family];
      const p = a?.readings.probability ?? null;
      out = { ...base, reading: readingOf(p), probability: p,
              resolved_model: a?.resolved_identity ?? null,
              identity_assurance: a?.identity_assurance ?? null, reason: null };
    } catch (err) {
      out = { ...base, reading: "unavailable", probability: null, resolved_model: null,
              identity_assurance: null,
              reason: err instanceof Error ? err.message.replace(/^ERROR:\s*/, "").slice(0, 300) : String(err) };
    }
  }
  await persistAssessment(out);
  return out;
}

/** One `zz.assessment` row, in the shape the table itself declares (migration 077): a family
 *  question xor an evaluator question, and only a `choice`/`score` answer ever carries a
 *  `distribution`. Building it in one place is what keeps `assessFamily` and
 *  `recordEvaluatorAssessment` writing rows the table's own checks agree on. */
interface AssessmentInsertRow {
  family: string | null;
  evaluator_version_id: string | null;
  instruction_version: number;
  question_digest: string;
  reading: Assessment["reading"] | null;
  probability: number | null;
  distribution: Readonly<Record<string, number>> | null;
  answer_kind: "noul" | "choice" | "score";
  requested_model: string | null;
  resolved_model: string | null;
  identity_assurance: string | null;
  reason: string | null;
  initiative: string | null;
  about: string | null;
  asked_by: string;
  asked_at: string;
}

/** The one insert both callers share. Returns the new row's id — `recordEvaluatorAssessment`
 *  needs it for `assessment_id`; `assessFamily`'s `Assessment` has never carried one and does
 *  not start now. Throws on any failure: whether that is swallowed or not is each caller's own
 *  call, made where it decides what a failure means for it. */
async function insertAssessmentRow(row: AssessmentInsertRow): Promise<number> {
  const p = db();
  if (!p) throw new Error("no platform database configured");
  const { rows } = await p.query<{ id: string }>(`
    insert into zz.assessment
      (family, evaluator_version_id, instruction_version, question_digest, reading, probability,
       distribution, answer_kind, requested_model, resolved_model, identity_assurance, reason,
       initiative, about, asked_by, asked_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    returning id`,
    [row.family, row.evaluator_version_id, row.instruction_version, row.question_digest,
     row.reading, row.probability, row.distribution ? JSON.stringify(row.distribution) : null,
     row.answer_kind, row.requested_model, row.resolved_model, row.identity_assurance,
     row.reason, row.initiative, row.about, row.asked_by, row.asked_at]);
  return Number(rows[0]?.id);
}

/** The provenance row for a family question. Never throws: an answer in hand is not lost to a
 *  database hiccup — the store copy under `_assessments/` is the one the next move reads. */
async function persistAssessment(a: Assessment): Promise<void> {
  try {
    await insertAssessmentRow({
      family: a.family, evaluator_version_id: null, instruction_version: a.instruction_version,
      question_digest: a.question_digest, reading: a.reading, probability: a.probability,
      distribution: null, answer_kind: "noul", requested_model: a.requested_model,
      resolved_model: a.resolved_model, identity_assurance: a.identity_assurance,
      reason: a.reason, initiative: a.initiative, about: a.about, asked_by: a.asked_by,
      asked_at: a.asked_at,
    });
  } catch { /* the store copy is the one the next move reads */ }
}

/** `zz.eval_evaluator_version` as `recordEvaluatorAssessment` needs to read it: the exact row
 *  a `bounded_semantic`/`generative_critic` measure resolved to, with its stable identity. */
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
    select v.id, v.version, v.question, v.answer_schema, e.stable_key
      from zz.eval_evaluator_version v
      join zz.eval_evaluator e on e.id = v.evaluator_id
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
 *  it was never handed. */
export interface EvaluatorAssessmentResult {
  assessment_id: number;
  answer_kind: "noul" | "choice" | "score";
  probability: number | null;
  distribution: Readonly<Record<string, number>> | null;
  reading: Assessment["reading"] | null;
  resolved_model: string | null;
  identity_assurance: string | null;
  reason: string | null;
}

/** Ask one registered evaluator question about one subject, and record it.
 *
 * "Every model-backed measure resolves to a `zz.eval_evaluator_version`": the resolve happens
 * here, first, and an `evaluator_version_id` nothing registered is refused before any model is
 * asked. The primitive the typed service is asked (`noul`/`choice`/`score`) is the evaluator's
 * own declared shape, never the caller's choice — `evaluators.ts`'s `askEvaluator` is a thin
 * positional wrapper over this, and `discover.ts` (Task I-9) calls it directly the same way.
 *
 * Unlike `assessFamily`, the insert here is not wrapped in a swallowing `catch`: an insert
 * failure fails the call, because a plugin-eval measure with no `assessment_id` is a measure
 * that silently never happened, and `zz.eval_assessment` cannot reference a row that was never
 * written. */
export async function recordEvaluatorAssessment(opts: {
  evaluator_version_id: string; subject_text: string; context?: string; askedBy: string;
}): Promise<EvaluatorAssessmentResult> {
  const evaluator = await resolveEvaluatorVersion(opts.evaluator_version_id);
  const digest = evaluatorQuestionDigest(evaluator.stable_key, evaluator.version, evaluator.question);
  const asked_at = new Date().toISOString();
  const requested_model = configured()
    ? `typesafe/${(process.env.TYPESAFE_MODEL || "jev-latest").trim()}` : null;

  let reading: Assessment["reading"] | null = null;
  let probability: number | null = null;
  let distribution: Readonly<Record<string, number>> | null = null;
  let resolved_model: string | null = null;
  let identity_assurance: string | null = null;
  let reason: string | null = null;

  if (!configured()) {
    reading = "unavailable";
    reason = NOT_CONFIGURED;
  } else {
    const state = (opts.context ? `CONTEXT:\n${clip(opts.context)}\n\n` : "") +
      `SUBJECT:\n${clip(opts.subject_text)}`;
    const schema = evaluator.answer_schema;
    const question: Question = schema.type === "noul"
      ? { type: "noul", instructions: evaluator.question }
      : schema.type === "score"
      ? { type: "score", instructions: evaluator.question, criteria: schema.criteria }
      : { type: "choice", instructions: evaluator.question, criteria: schema.criteria };
    try {
      const answers = await ask(state, { q: question });
      const a = answers.q;
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
      reading = "unavailable";
      reason = err instanceof Error ? err.message.replace(/^ERROR:\s*/, "").slice(0, 300) : String(err);
    }
  }

  const assessment_id = await insertAssessmentRow({
    family: null, evaluator_version_id: evaluator.id, instruction_version: evaluator.version,
    question_digest: digest, reading, probability, distribution, answer_kind: evaluator.answer_schema.type,
    requested_model, resolved_model, identity_assurance, reason,
    initiative: null, about: null, asked_by: opts.askedBy, asked_at,
  });

  return {
    assessment_id, answer_kind: evaluator.answer_schema.type, probability, distribution, reading,
    resolved_model, identity_assurance, reason,
  };
}

/** Where an audit round's assessments live in the store. Underscore-prefixed, so no listing,
 *  index or document count treats it as a document. */
function assessmentFile(root: string, initiative: string, sourceFile: string): string {
  return join(root, initiative, "_assessments", sourceFile.replace(/\.md$/, ".json"));
}

export function writeRoundAssessments(root: string, initiative: string, sourceFile: string,
                                      assessments: Assessment[]): void {
  mkdirSync(join(root, initiative, "_assessments"), { recursive: true });
  writeFileSync(assessmentFile(root, initiative, sourceFile),
                JSON.stringify({ source: `sources/${sourceFile}`, assessments }, null, 2) + "\n");
}

/** One audit round's recorded assessments, keyed by family. Empty when none were taken. */
export function readRoundAssessments(root: string, initiative: string,
                                     sourceFile: string): Record<string, Assessment> {
  const file = assessmentFile(root, initiative, sourceFile);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { assessments?: Assessment[] };
    return Object.fromEntries((parsed.assessments ?? []).map((a) => [a.family, a]));
  } catch { return {}; }
}
