/**
 * `Refusal` — the one error type a helper may throw to answer a caller.
 *
 * ITS OWN MODULE BECAUSE IT IS THE ROOT OF THE GRAPH. Every layer under zz-core throws it and
 * none of them needs any of the others; leaving it in server.ts would have made server.ts a
 * dependency of the modules server.ts imports, which is a cycle rather than a layering.
 */

/** A database fault naming itself, thrown from a helper that a tool calls bare — `teamsFor`,
 *  `safePath` — with nothing between the helper and the tool boundary to catch it.
 *
 *  Every tool's own body already returns `text("ERROR: …")` inline for the refusals it knows
 *  about; a helper cannot do that, because its return type is a team name or a path, not a
 *  tool result. `Refusal` is how the message still reaches the caller in that same shape: it
 *  carries the finished house-style text, and the `registerTool` wrapper installed right
 *  after the server is constructed catches only THIS type and turns it into `text(message)` —
 *  a plain refusal, not an SDK `isError` result. Anything that is not a `Refusal` — a real bug
 *  — keeps propagating exactly as it does today; this does not make failures quieter. */
export class Refusal extends Error {}
