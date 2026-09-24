/**
 * `Refusal` — the one error type a helper may throw to answer a caller.
 *
 * This module imports nothing, so every layer under zz-core can throw it without any of them
 * depending on the others.
 */

/** A database fault naming itself, thrown from a helper that a tool calls bare — `teamsFor`,
 *  `safePath` — with nothing between the helper and the tool boundary to catch it.
 *
 *  A tool body returns `text("ERROR: …")` inline for the refusals it knows about; a helper
 *  cannot, because its return type is a team name or a path, not a tool result. A `Refusal`
 *  carries the finished house-style text instead.
 *
 *  COUPLED: the `registerTool` wrapper installed right after the server is constructed
 *  catches only this type and turns it into `text(message)` — a plain refusal, not an SDK
 *  `isError` result. Anything that is not a `Refusal` keeps propagating. */
export class Refusal extends Error {}
