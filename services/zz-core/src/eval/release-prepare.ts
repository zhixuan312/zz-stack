/**
 * The one write `release_prepare` and `proposal_prepare` (`release.ts`) share: a ledger row and
 * the initiative's `release_mode` branch fact (FR-58), decided and written in ONE transaction on
 * ONE pooled connection.
 *
 * Why one connection: the facts check-and-write must be serialized against every other writer of
 * the same initiative's facts, in this process and in any other sharing the database. It used to
 * hold a session advisory lock on a pooled connection of its own for the whole body while
 * `withIdempotency` took a second for the ledger transaction — two connections per call, and four
 * concurrent prepares on the four-connection pool each held one and waited forever for another.
 * Now the lock is `pg_advisory_xact_lock` on the ledger transaction's own client
 * (`lockInitiativeFacts`, taken inside `writeBranchFacts`), released by that transaction's
 * COMMIT or ROLLBACK, and the in-process queue (`withInitiativeFactsLock`) keeps this process's
 * waiters from each holding a connection while they wait.
 *
 * DELIBERATE: the `_facts.json` write happens inside the transaction, before the ledger row
 * commits. A refused fact (a different `release_mode` already set, an unopened initiative)
 * throws, so the ledger row and the mutator's own row roll back with it and nothing is written.
 * A commit that fails AFTER the file write leaves the fact standing with no row behind it — a
 * retry proceeds fresh and writes the same fact as a no-op, and a same-key twin that loses the
 * ledger race rolls back its row over a file the lock guarantees it agreed with. Neither can
 * leave the file naming a branch no call chose.
 */
import type pg from "pg";

import { Refusal } from "../refusal.js";
import { factsFor, withInitiativeFactsLock } from "../initiative-record.js";
import { safeName } from "../paths.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { writeBranchFacts } from "./protocol.js";

/** `place` is resolved by the caller BEFORE this runs — `userRoot`/`teamFor` query the pool on
 *  a cache miss, and a query on the pool while the ledger's client is held is a second
 *  connection. */
export async function prepareWithBranchFact<T>(
  principal: string, tool: string, key: string, args: Record<string, unknown>,
  place: { readonly root: string; readonly team: string | null; readonly initiative: string },
  releaseMode: "promotable" | "proposal_only",
  fn: (client: pg.PoolClient) => Promise<MutatorOutcome<T>>,
): Promise<{ readonly outcome: IdempotencyOutcome<T>; readonly facts: Record<string, string> }> {
  const { root, team, initiative } = place;
  const bad = safeName(initiative, "initiative");
  if (bad) throw new Refusal(bad);

  let facts: Record<string, string> | null = null;
  const outcome = await withInitiativeFactsLock(initiative, () => withIdempotency(
    principal, tool, key, args,
    async (client): Promise<MutatorOutcome<T>> => {
      const written = await fn(client);
      const decided = await writeBranchFacts(initiative, { release_mode: releaseMode }, { client, root, team });
      if (typeof decided === "string") throw new Refusal(decided);
      facts = decided;
      return written;
    },
  ));
  // A replay wrote nothing this time; the fact its first call recorded is on file.
  return { outcome, facts: facts ?? factsFor(root, initiative) };
}
