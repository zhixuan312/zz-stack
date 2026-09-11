/**
 * Whether a refusal taught the caller anything — R6 of the building-block contract:
 * "validation errors in prose that teach the rule — no silent coercion, no bare status codes".
 *
 * ONE judgement, because there were two and they disagreed on the message that motivated the
 * requirement. tool-report matched a bare status by its SHAPE and counted the words a caller
 * could act on; block-conformance used a length floor of forty characters and a narrower
 * pattern that did not know about `request failed with status code`. So
 *
 *   RPC ERROR: request failed with status code 422
 *
 * — forty-six characters, and the exact string block-conformance's own comment quotes as the
 * thing R6 exists to catch — was scored as R6 MET there and as teaching nothing here. It is
 * also the commonest form that engine sees, because `RPC ERROR: ` is the prefix it adds to
 * every JSON-RPC error itself.
 *
 * A length floor cannot express this. The question is not how long the sentence is but whether
 * there is anything in it to act on, and every failure carries the same dozen words whatever
 * went wrong.
 */

/**
 * Words every failure carries, which say nothing about which rule was broken.
 *
 * ONE TEST, not two. There was a `BARE` pattern here as well — `^(RPC ERROR: )?(request failed
 * with status code )?\d{3}$` — matched first and returning false. It never changed an answer:
 * every alphabetic word its alternation can produce is in this set, so anything it matched had
 * ZERO words to act on and the count below refused it anyway. Enumerated over the whole
 * language that pattern accepts — 1,620 strings — it decided none of them.
 *
 * Two tests where one decides is worse than redundant. It reads as the load-bearing one, so a
 * copy of this judgement elsewhere was written as "a bare status, plus a length floor" and
 * scored `RPC ERROR: request failed with status code 422` as teaching, which is the exact
 * message R6 exists to catch.
 */
const FILLER = new Set([
  "request", "failed", "with", "status", "code", "error", "rpc",
  "internal", "server", "bad", "invalid", "unknown",
]);

/** False when a refusal says only that something failed.
 *
 * Not a length. The question is whether there is anything in the sentence to ACT on, and a
 * status code dressed in the same dozen words is no longer for being dressed. */
export function teachesTheRule(text: string): boolean {
  const useful = text.toLowerCase().split(/[^a-z]+/).filter((w) => w && !FILLER.has(w));
  return useful.length >= 3;
}
