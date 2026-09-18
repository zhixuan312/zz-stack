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
    Promise<{ dimension: string; meets: boolean; fact: string }[]> {
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
