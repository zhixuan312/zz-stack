/**
 * THE TEXT A JUDGE READS, WITHIN THE BUDGET A JUDGE WILL ACCEPT — a pair, or one document.
 *
 * SPLIT OUT OF judge.ts BY SUBJECT, the same cut judge-trace.ts already is. That file runs the
 * round; this one answers a narrower question — what does a whole arc look like to somebody
 * asked whether its end delivered its beginning — and the answer is a rendering problem, not a
 * judging one.
 *
 * LABELLED, because the judge is asked whether the second answers the first and has to be able
 * to tell them apart. An unlabelled concatenation reads as one long document and the question
 * becomes unanswerable.
 *
 * AND NEITHER END CROWDS THE OTHER OUT. Truncating the concatenation from its end would feed
 * the whole beginning and none of the conclusion, which is the one comparison this subject
 * exists to make, so each end gets HALF the budget. A cut is announced in the text the judge
 * reads as well as counted in what comes back — a judge that cannot see it was handed an
 * excerpt marks it as though it were the whole, and a stored record that does not carry the
 * figure claims more coverage than it had.
 */

/** The most of an INITIATIVE PAIR a judgement service is given, in characters, split evenly
 *  between the two ends.
 *
 *  DERIVED FROM THE SERVICE'S MEASURED CEILING, not chosen for safety. It was 24,000 — a number
 *  picked to stay clear of a `max_tokens_exceeded` that had lost a subject once, never measured
 *  against what the service actually accepts. That caution cost more than it saved: across six
 *  real initiatives it cut 210,702 characters, and the worst-marked subject in that round was
 *  the one that lost 113,332 of them. A judge shown a third of an arc and asked whether the end
 *  answers the beginning is being asked about an excerpt.
 *
 *  Three measurements against the live service settle it:
 *    32,275 input tokens is accepted and ~36,400 is refused, so the ceiling is 32,768 (2^15).
 *    Real documents run 3.01 characters per token -- a 42,531-character explore.md measured
 *    14,117 tokens -- and NOT the ~5 a synthetic probe suggests, so a cap derived from repeated
 *    words would have been wrong by two thirds.
 *    The ruler's own text rides in the same request: three dimensions of five written levels,
 *    plus instructions, and that has to fit too.
 *
 *  70,000 is what those leave. At a pathological 2.5 characters per token it is 28,000 tokens,
 *  and 3,000 for the questions still clears 32,768. On the six initiatives above, four would
 *  have been judged with NO truncation at all and a fifth with 8,231 characters cut instead of
 *  54,231. Overridable, because a service with a larger window is the same contract with a
 *  different number -- and the number is now one a re-measurement can move. */
const PAIR_CAP = Number(process.env.ZZ_JUDGE_PAIR_CAP || 70_000);

/** One body cut to `limit`, with the cut announced in the text itself. A judge that cannot see
 *  it was handed an excerpt marks the excerpt as though it were the whole. */
function cutTo(body: string, limit: number): { text: string; lost: number } {
  return body.length <= limit
    ? { text: body, lost: 0 }
    : { text: `${body.slice(0, limit)}\n\n[TRUNCATED: ${body.length - limit} of ${body.length} characters not shown]`,
        lost: body.length - limit };
}

/** ONE DOCUMENT, within the same budget.
 *
 *  This branch had NO cap at all, and the reason it went unnoticed is that the pair branch got
 *  one first: two documents obviously risk the ceiling, one apparently does not. Measured, it
 *  does — a real spec.md reached 153,379 characters, about 51,000 tokens against a 32,768
 *  ceiling, and the service answered `max_tokens_exceeded`. The subject scored NOTHING, which
 *  is the failure the pair cap exists to prevent, arriving through the branch nobody capped.
 *
 *  The whole budget rather than half, because there is only one document to fit. */
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
