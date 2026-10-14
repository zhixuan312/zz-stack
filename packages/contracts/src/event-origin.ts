/**
 * Where a call came from — the one classification of a client name.
 *
 * In contracts because `zz.event` has two writers and neither may own the rule: the gateway
 * writes a row per tool call and zz-core writes its own, and the `x-zz-client` header reaches
 * both. A copy in either would count the same call as work on one side and as maintenance on
 * the other.
 *
 * The name is the caller's own claim. An origin sorts traffic for counting; it proves nothing
 * about who made the call and decides no access.
 */

/** The clients whose calls are the platform maintaining itself: the release check, an import
 *  and the doctor. Every other sender is work; adding one is one entry here. */
export const PLATFORM_CLIENTS: readonly string[] = Object.freeze(["chain-check", "zz-migrate", "zz-doctor"]);

export type EventOrigin = "work" | "platform";

/** The origin of a call, from its `x-zz-client` header as sent: `platform` when the lower-cased
 *  name, cut at the first `/` and then at the first space, is one of `PLATFORM_CLIENTS`, and
 *  `work` for every other name, an empty one and a missing one.
 *
 *  COUPLED: the backfill of `zz.event.origin` in the gateway's migration spells this tokenisation
 *  in SQL, `lower(split_part(split_part(client, '/', 1), ' ', 1))`, and the two must cut alike or
 *  a row written before the column and one written after it disagree about the same client.
 *
 *  DELIBERATE: only `/` and a space cut, and the name is not trimmed, because `split_part` does
 *  neither — a tab or a leading space leaves a token that is none of the three. */
export function eventOrigin(client: string | null | undefined): EventOrigin {
  if (typeof client !== "string") return "work";
  const token = client.toLowerCase().split("/")[0].split(" ")[0];
  return PLATFORM_CLIENTS.includes(token) ? "platform" : "work";
}
