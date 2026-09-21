/**
 * Marking an artifact with TYPED JUDGMENTS — the half of judging that answers shapes.
 *
 * SPLIT OUT OF judge.ts BY SUBJECT. That file is the round: which subjects exist, which are
 * already scored, what the control reads, how a mark is stored. This is one question asked one
 * way — place this artifact on these named levels — and it is a different subject because the
 * SERVICE is different and so is what it can be asked.
 *
 * WHICH MODEL DOES WHAT, and this is the whole architecture in one line: the typed service
 * answers SHAPES — a position on named levels, an option from a set, a probability — and the
 * language model writes the PROSE that explains them. So `quote` and `why` come back empty
 * here by design, not by loss: the explanation of a mark is not the typed judge's to give, and
 * asking a shape-answering service for a sentence would be using it for the one thing it is
 * not for.
 *
 * The reading happens afterwards and in the other direction. The report stage takes these marks
 * — with their distributions and confidences — reads the artifact beside them, and writes what
 * the numbers mean. That keeps the two failure modes apart: a typed answer cannot be
 * off-vocabulary or unparseable, and a written explanation cannot invent a score, because the
 * score was already fixed before any prose was written.
 */
import { ask as askTyped, type ScoreQuestion, toOneBased } from "./typesafe.js";
import type { Dim, Mark } from "./judge.js";

/** Mark one artifact against every qualitative dimension, as TYPED JUDGMENTS.
 *
 * ONE REQUEST FOR THE WHOLE RULER. The service evaluates its questions in parallel and its own
 * documentation is explicit that "adding questions barely changes the response time", so a call
 * per dimension would pay the round trip N times to learn the same thing.
 *
 * WHAT THIS GAINS: a mark that cannot be off-scale or unparseable, a probability distribution
 * over the levels, and a confidence that is the shape of that distribution rather than the
 * model's opinion of itself. A 3 nobody was sure of and a 3 that was obvious are different
 * findings, and only one of them is worth re-reading.
 *
 * WHICH MODEL DOES WHAT, and this is the whole architecture in one line: the typed service
 * answers SHAPES — a position on named levels, an option from a set, a probability — and the
 * language model writes the PROSE that explains them. So `quote` and `why` are empty here by
 * design, not by loss: the explanation of a mark is not the typed judge's to give, and asking a
 * shape-answering service for a sentence would be using it for the one thing it is not for.
 *
 * The reading happens afterwards and in the other direction. The report stage takes these marks
 * — with their distributions and confidences — reads the artifact beside them, and writes what
 * the numbers mean. That keeps the two failure modes apart: a typed answer cannot be
 * off-vocabulary or unparseable, and a written explanation cannot invent a score, because the
 * score was already fixed before any prose was written.
 *
 * The scale is rebased: System One numbers levels from zero, every mark this platform has
 * stored is 1-based, and a round that silently changed base would make one ruler's 1 mean
 * another's 2. */
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
    // THE READINGS, NOT THE BODY. `askTyped` has already refused anything the adapter would
    // not validate, so a figure that arrives here is on the scale this dimension declared and
    // a distribution that arrives here is over levels it declared. A dimension with no score
    // is skipped rather than defaulted, for the reason it always was: a mark nobody made.
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
