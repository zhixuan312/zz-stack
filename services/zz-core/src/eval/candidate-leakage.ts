/**
 * The leakage critic (FR-38, FR-43): one registered evaluator asked about one candidate patch —
 * "does this read as though it leaked or hard-coded evidence it should not have?" Asked twice in
 * a candidate's life, with two different bars:
 *   - `candidate_validate`, before a `recorded` candidate is ever built: only a clear `yes`
 *     rejects it (`rejected_precheck`). `unclear`/`unavailable` admit it, the same "never drops a
 *     candidate for a model outage" rule `discover.ts` states — a search is not blocked by an
 *     inconclusive read.
 *   - `candidate_prove`, against the finished proof evidence: FR-43's "no unresolved leakage" is
 *     an eligibility line, so there `unclear`/`unavailable` is `not_established`
 *     (`leakage_unresolved`), never a pass (`candidate-prove-decide.ts`).
 * The answer comes back UNRECORDED (`pending`): each caller writes it with the state change it
 * decided, `candidate_prove` inside its ledger transaction.
 *
 * `candidate_validate` retries a build that timed out, and a retry screens again. `reuse` lets it
 * read back the answer an earlier screen of the SAME subject recorded (keyed on
 * `zz.assessment.about`: patch digest plus hypothesis digest — the whole subject the critic
 * reads) rather than ask the critic again. `unavailable` is never reused: that was an outage,
 * not an answer. `candidate_prove` never passes `reuse` — proof asks fresh.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

import { registerEvaluator, type EvaluatorDefinition } from "./evaluators.js";
import type { TouchedComponent } from "./complexity.js";
import { askEvaluatorQuestion, type AskedEvaluatorAnswer } from "../semantic.js";

const LEAKAGE_EVALUATOR: EvaluatorDefinition = {
  stable_key: "search.leakage",
  kind: "noul",
  question:
    "Below is one candidate patch a search proposed against a plugin under optimization — its " +
    "hypothesis, the files it touches, and an excerpt of its own unified diff. The proposer may " +
    "read this run's evolve evidence and its own prior validation results, but must never see " +
    "sealed proof cases or evaluation-oracle content, and must never repeat a hypothesis already " +
    "rejected. Does this candidate's hypothesis or patch read as though it leaked or hard-coded " +
    "specific evidence it should not have — a literal case id, a literal expected answer, a " +
    "special case that only matches known evidence content, or a hypothesis restating a rejected " +
    "one in different words — rather than implementing a genuinely general fix a proposer could " +
    "justify from evolve evidence alone?",
  answer_schema: { type: "noul" },
  polarity: {},
  model_policy: {},
};

/** Exactly what a leakage screen reads — both callers load candidate rows of different shapes. */
interface LeakageSubject {
  readonly hypothesis: string;
  readonly diff: string;
  readonly touched_components: readonly TouchedComponent[];
}

interface LeakageVerdict {
  readonly reading: "yes" | "no" | "unclear" | "unavailable";
  /** The critic's own finding on `yes`, or why there is no reading on `unavailable`. */
  readonly reason: string | null;
  /** The answer to record — null when `reuse` found an earlier recorded one. */
  readonly pending: AskedEvaluatorAnswer | null;
}

type Reading = LeakageVerdict["reading"];

function verdictOf(reading: Reading, probability: number | null, reason: string | null): Omit<LeakageVerdict, "pending"> {
  if (reading === "yes") {
    return {
      reading,
      reason: `leakage critic flagged this candidate (probability ${probability?.toFixed(2) ?? "?"}) ` +
        "as likely relying on evidence it should not have, or restating a rejected hypothesis",
    };
  }
  return { reading, reason: reading === "unavailable" ? reason : null };
}

/** Registers the critic (idempotent by content digest) and asks it about `candidate`. No write.
 *  With `reuse`, an earlier recorded answer about the same subject is returned instead (see the
 *  module note), and a fresh answer carries the key it will be found by next time. */
export async function screenLeakage(
  candidate: LeakageSubject, principal: string,
  reuse?: { readonly pool: pg.Pool; readonly patchDigest: string },
): Promise<LeakageVerdict> {
  const evaluator = await registerEvaluator(LEAKAGE_EVALUATOR);
  const about = reuse
    ? `candidate_patch:${reuse.patchDigest}:${createHash("sha256").update(candidate.hypothesis).digest("hex").slice(0, 16)}`
    : null;
  if (reuse && about) {
    const earlier = (await reuse.pool.query<{ reading: Reading; probability: number | null }>(`
      select reading, probability from zz.assessment
       where evaluator_version_id = $1::uuid and about = $2 and reading in ('yes', 'no', 'unclear')
       order by asked_at desc limit 1`, [evaluator.evaluator_version_id, about])).rows[0];
    if (earlier) return { ...verdictOf(earlier.reading, earlier.probability, null), pending: null };
  }
  const touched = candidate.touched_components.map((c) => c.path).join(", ") || "(no files parsed from this patch)";
  const subject =
    `HYPOTHESIS: ${candidate.hypothesis}\n` +
    `TOUCHED FILES: ${touched}\n` +
    `DIFF EXCERPT:\n${candidate.diff.slice(0, 2000)}`;
  const asked = await askEvaluatorQuestion({
    evaluator_version_id: evaluator.evaluator_version_id, subject_text: subject, askedBy: principal,
  });
  const pending: AskedEvaluatorAnswer = about ? { ...asked, row: { ...asked.row, about } } : asked;
  const reading = pending.result.reading ?? "unavailable";
  return { ...verdictOf(reading, pending.result.probability, pending.result.reason), pending };
}
