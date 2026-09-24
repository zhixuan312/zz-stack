/**
 * Marking an artifact with typed judgments — the half of judging that answers shapes. judge.ts
 * is the round: which subjects exist, which are already scored, what the control reads, how a
 * mark is stored.
 *
 * The typed service answers shapes — a position on named levels, an option from a set, a
 * probability — and the language model writes the prose that explains them. The report stage
 * takes these marks with their distributions and confidences, reads the artifact beside them,
 * and writes what the numbers mean. So a typed answer cannot be off-vocabulary or
 * unparseable, and a written explanation cannot invent a score, because the score was fixed
 * before any prose was written.
 */
import { ask as askTyped, type ScoreQuestion, toOneBased } from "../typed-service.js";
import type { Dim, Mark } from "./judge.js";

/** Mark one artifact against every qualitative dimension, as typed judgments.
 *
 * One request for the whole ruler: the service evaluates its questions in parallel, so a call
 * per dimension would pay the round trip N times for the same answers.
 *
 * Each mark carries a probability distribution over the levels and a confidence that is the
 * shape of that distribution rather than the model's opinion of itself.
 *
 * DELIBERATE: `cite` and `why` come back empty. The explanation of a mark is the report
 * stage's to write, not the typed judge's — see this file's header.
 *
 * The scale is rebased: System One numbers levels from zero and every mark this platform
 * stores is 1-based, so an unrebased round would make one ruler's 1 mean another's 2. */
export async function markTyped(dims: Dim[], artifact: string): Promise<Mark[]> {
  const questions: Record<string, ScoreQuestion> = {};
  for (const [i, d] of dims.entries()) {
    questions[`d${i}`] = {
      type: "score",
      instructions: d.name,
      criteria: d.levels as string[],
    };
  }
  const answers = await askTyped(artifact, questions);
  const marks: Mark[] = [];
  for (const [i, d] of dims.entries()) {
    // The readings, not the body: `askTyped` has already refused anything the adapter would
    // not validate, so a figure arriving here is on the scale this dimension declared and a
    // distribution is over its levels. A dimension with no score is skipped rather than
    // defaulted — it is a mark nobody made.
    const a = answers[`d${i}`];
    if (!a || a.readings.score === null) continue;
    marks.push({
      dimension: d.name,
      score: toOneBased(a.readings.score),
      cite: "",
      why: "",
      confidence: a.readings.confidence ?? undefined,
      probabilities: a.readings.distribution ?? undefined,
    });
  }
  return marks;
}
