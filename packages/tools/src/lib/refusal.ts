/**
 * Whether a refusal taught the caller anything: a validation error in prose that teaches the
 * rule, never a bare status code.
 *
 * A length floor cannot express it: the question is not how long the sentence is but whether
 * there is anything in it to act on, and
 *
 *   RPC ERROR: request failed with status code 422
 *
 * is forty-six characters that teach nothing. `RPC ERROR: ` is the prefix the engine adds to
 * every JSON-RPC error, so that is the commonest form it produces.
 */

/**
 * Words every failure carries, which say nothing about which rule was broken.
 * A bare status line such as the one above is made only of these words, so it needs no
 * pattern of its own.
 */
const FILLER = new Set([
  "request", "failed", "with", "status", "code", "error", "rpc",
  "internal", "server", "bad", "invalid", "unknown",
]);

/** False when a refusal says only that something failed. */
export function teachesTheRule(text: string): boolean {
  const useful = text.toLowerCase().split(/[^a-z]+/).filter((w) => w && !FILLER.has(w));
  return useful.length >= 3;
}
