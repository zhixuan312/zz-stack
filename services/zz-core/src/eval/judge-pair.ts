/**
 * The text a judge reads, within the budget a judge will accept — a pair, or one document.
 *
 * judge.ts runs the round; this answers what a whole arc looks like to somebody asked whether its
 * end delivered its beginning, which is a rendering problem rather than a judging one.
 *
 * The two ends are labelled, because an unlabelled concatenation reads as one long document and
 * the question becomes unanswerable. Each end gets half the budget, so truncating from the end
 * cannot feed the whole beginning and none of the conclusion. A cut is announced in the text the
 * judge reads as well as counted in what comes back: a judge that cannot see it was handed an
 * excerpt marks it as though it were the whole.
 */

/** The most of an initiative pair a judgement service is given, in characters, split evenly
 *  between the two ends.
 *
 *  Sized against a 32,768-token input ceiling, with the ruler's own text riding in the same
 *  request. Real documents run about three characters per token; at a pathological 2.5 this cap
 *  is 28,000 tokens, which leaves room for the questions. A cap derived from repeated words
 *  assumes about five and is wrong by two thirds. Overridable, because a service with a larger
 *  window is the same contract with a different number. */
const PAIR_CAP = Number(process.env.ZZ_JUDGE_PAIR_CAP || 70_000);

/** One body cut to `limit`, with the cut announced in the text itself. A judge that cannot see
 *  it was handed an excerpt marks the excerpt as though it were the whole. */
function cutTo(body: string, limit: number): { text: string; lost: number } {
  return body.length <= limit
    ? { text: body, lost: 0 }
    : { text: `${body.slice(0, limit)}\n\n[TRUNCATED: ${body.length - limit} of ${body.length} characters not shown]`,
        lost: body.length - limit };
}

/** One document, within the same budget — the whole of it rather than half, because there is
 *  only one document to fit. A single spec.md can exceed the ceiling on its own, and the service
 *  answers `max_tokens_exceeded` for the whole subject rather than marking what it could read. */
export function bodyWithin(body: string | null): { text: string; truncated: number } {
  const c = cutTo(body ?? "", PAIR_CAP);
  return { text: c.text, truncated: c.lost };
}

/** Both ends of one initiative, labelled and within budget. `truncated` is what was cut, so
 *  neither the judgement nor the stored record can claim more coverage than it had. Either end
 *  missing yields empty text, which the caller reports as a subject it could not read. */
export function pairOf(
  initiative: string, openPath: string, openBody: string | null,
  closePath: string, closeBody: string | null,
): { text: string; truncated: number } {
  const half = Math.floor(PAIR_CAP / 2);
  const a = cutTo(openBody ?? "", half);
  const b = cutTo(closeBody ?? "", half);
  return a.text.trim() && b.text.trim()
    ? { text: `=== THE BEGINNING: ${initiative}/${openPath} ===\n\n${a.text}\n\n` +
              `=== THE END: ${initiative}/${closePath} ===\n\n${b.text}`,
        truncated: a.lost + b.lost }
    : { text: "", truncated: 0 };
}
