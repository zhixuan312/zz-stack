/**
 * Applying a person's LINE to a tool's FIGURE — the pass that never reads the artifact.
 *
 * SPLIT OUT OF judge.ts BY SUBJECT. Everything else in judging places an artifact on a scale by
 * reading it. This does the opposite and it is the boundary the whole design rests on: a
 * quantitative dimension is a threshold somebody wrote over a number a tool computed, so the
 * artifact is not an input at all. Showing the judge a document and asking whether
 * `never_called` clears a ceiling would be asking it to re-derive a figure the document does
 * not contain — which is how a measured fact quietly becomes an impression.
 *
 * It runs on the real round only. A control round substitutes another subject's artifact, and
 * these dimensions do not read the artifact — so under a control they would score exactly what
 * they scored on the real round, identical rows on both arms, shrinking by arithmetic the very
 * gap the control exists to measure.
 */
import type pg from "pg";

import { ask, type Dim, matcher } from "./judge.js";
import { ask as askTyped, configured as typedConfigured, type NoulQuestion } from "./typesafe.js";

/** What a threshold answer carries, whichever service produced it. `confidence` and
 *  `probabilities` are present only from the typed service — the reading judge answers a
 *  boolean and has no distribution behind it to report. */
interface Applied {
  dimension: string; meets: boolean; fact: string;
  confidence?: number; probabilities?: Record<string, number>;
}

/** A LINE OVER A FIGURE IS A YES/NO, WHICH IS A PRIMITIVE THE TYPED SERVICE HAS.
 *
 * This is the most quantitative decision in the whole flow -- does 15 of 45 clear a half line
 * -- and it was the last one still being made by a transformer returning JSON. The cost was
 * not wrong judgement; it was SHAPE. The parser below this used to coerce `"true"` the string
 * into `true` the boolean because a model asked for a boolean returns the string often enough
 * to turn a met line into an unmet one, and a truncated answer silently dropped a dimension.
 * `noul` cannot answer off-vocabulary: it returns the probability that the line holds, plus
 * the confidence that is the shape of that distribution.
 *
 * 0.5 IS THE CUT, because a threshold is binary by construction -- a band between met and
 * unmet would be this pass inventing degrees the ruler did not write. But the probability is
 * STORED beside the verdict, so a line cleared at 0.51 and one cleared at 0.99 stop looking
 * identical in the record. A threshold whose probability sits near the cut is a threshold
 * nobody drew sharply enough, and that is worth being able to see. Measured against the live
 * service: "15 of 45 clears at least half" answers 0.02, and "the documentation is generally
 * quite good" answers 0.41 -- the vague line reports its own vagueness.
 *
 * `confidence` IS DERIVED HERE AND SAID TO BE. Unlike choice and score, noul returns no
 * confidence of its own -- for a yes/no the probability already IS the shape of the
 * distribution, so there is nothing separate to report. Distance from the cut, doubled, is
 * that same shape on the 0-1 scale the column holds for every other dimension: 0.02 and 0.98
 * both read 0.96, and 0.51 reads 0.02.
 *
 * The facts are put in `state` and each line becomes one question, so every threshold in a
 * ruler rides in ONE request -- the service evaluates them in parallel and the round trip is
 * paid once. */
async function typedThresholds(dims: Dim[], facts: string): Promise<Applied[]> {
  const questions: Record<string, NoulQuestion> = {};
  dims.forEach((d, i) => {
    questions[`t${i}`] = {
      type: "noul",
      instructions:
        `Do the facts meet this line? THE LINE: ${d.threshold}\n\n` +
        "Answer only whether the recorded facts satisfy it. You are not judging quality and " +
        "you are not deciding where the line should be -- it was written down before any of " +
        "these measurements were taken. If the facts do not contain the figure this line " +
        "needs, the line is NOT met.",
    };
  });
  const answers = await askTyped(facts, questions);
  return dims.map((d, i) => {
    // THE PROBABILITY AS THE ADAPTER VALIDATED IT. `askTyped` refuses the whole set if any
    // line came back as anything but a probability between 0 and 1, so the null branch below
    // is now unreachable through the service and is kept as the answer to a line that somehow
    // carries none -- ABSENT IS NOT MET, which is the rule the fallback path states too.
    const p = answers[`t${i}`]?.readings.probability ?? null;
    if (p === null) {
      return { dimension: d.name, meets: false, fact: "the typed judge returned no answer for this line" };
    }
    return {
      dimension: d.name,
      meets: p > 0.5,
      fact: `the typed judge put ${Math.round(p * 100)}% on this line holding, ` +
            `read against: ${d.threshold}`,
      confidence: Math.round(Math.abs(p - 0.5) * 200) / 100,
      probabilities: { met: p, unmet: Math.round((1 - p) * 100) / 100 },
    };
  });
}

/** The threshold pass: quantitative dimensions, scored against figures a tool computed.
 *
 * THE MODEL IS NOT ASKED WHETHER THIS IS GOOD. It is asked one question per dimension — does
 * the recorded threshold hold against the recorded fact — and the stored `reason` is the
 * ruler's own threshold_reason rather than anything it says back. That ordering is the whole
 * guard: the line was written down before any artifact was measured, so it cannot be moved
 * afterwards to flatter the number it produces, and a reason generated here would be exactly
 * that move made invisibly.
 *
 * Met is 5 and unmet is 1 because a line is binary. A band between them would be this pass
 * inventing degrees the ruler did not write.
 */
export async function applyThresholds(p: pg.Pool, plugin: string | null, dims: Dim[], facts: string):
    Promise<Applied[]> {
  // THE TYPED SERVICE FIRST, because a line over a figure is exactly what it answers. The
  // reading judge stays as the fallback for a deployment with no key -- absence is an answer,
  // never an error -- and it is the only path that can return a shape nobody can parse.
  if (typedConfigured()) return typedThresholds(dims, facts);
  const system = [
    "The message below is a set of facts about one subject, computed by a tool with no model",
    "anywhere in the derivation. You are applying thresholds that were written down BEFORE any",
    "of those measurements were taken. You are not judging quality, you are not reading any",
    "artifact, and you are not deciding where a line should be.",
    "",
    "THE THRESHOLDS:",
    ...dims.map((d) => `- ${d.name}\n    the line: ${d.threshold}`),
    "",
    "For each one, answer whether the line is met by the facts above, and quote the single",
    "figure you read it against. If the facts do not contain the figure a threshold needs, the",
    "line is NOT met and the quote says which figure is missing.",
    "",
    'Answer as JSON only: {"met": [{"dimension": string, "meets": boolean, "fact": string}]}',
  ].join("\n");
  const got = await ask(p, plugin, system, facts);
  const said = (got?.met as { dimension?: unknown; meets?: unknown; fact?: unknown }[] | undefined) ?? [];
  const dimOf = matcher(dims);
  const answered = new Map<string, { meets: boolean; fact: string }>();
  for (const one of said) {
    const id = dimOf(one.dimension);
    if (!id || answered.has(id)) continue;
    answered.set(id, {
      // The type is not trusted, for the same reason the qualitative pass coerces its score: a
      // model asked for a boolean returns the string "true" often enough that reading it
      // strictly turns a met line into an unmet one.
      meets: one.meets === true || String(one.meets).toLowerCase() === "true",
      fact: String(one.fact ?? "").slice(0, 800),
    });
  }
  return dims.map((d) => {
    const hit = answered.get(d.dim_id);
    return {
      dimension: d.name,
      // ABSENT IS NOT MET. A dimension the answer skipped has no evidence that its line holds,
      // and scoring it met would let a truncated answer pass a threshold silently.
      meets: hit?.meets ?? false,
      fact: hit?.fact || "the answer said nothing about this dimension",
    };
  });
}
