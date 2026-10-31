/**
 * The one write `release_prepare` and `proposal_prepare` (`release.ts`) share: a ledger row and
 * the initiative's `release_mode` branch fact (FR-58), decided and written in ONE transaction on
 * ONE pooled connection.
 *
 * Why one connection: the facts check-and-write must be serialized against every other writer of
 * the same initiative's facts, in this process and in any other sharing the database, without
 * a call ever holding two of the pool's connections. The lock is `pg_advisory_xact_lock` on the
 * ledger transaction's own client (`lockInitiativeFacts`, taken inside `writeBranchFacts`),
 * released by that transaction's COMMIT or ROLLBACK, and the in-process queue
 * (`withInitiativeFactsLock`) keeps this process's waiters from each holding a connection while
 * they wait.
 *
 * The fact is a `zz.initiative_fact` row written on that same client, so the fact, the
 * mutator's own row and the ledger row commit or roll back together: a refused fact (a different
 * `release_mode` already set, an unopened initiative) throws, and nothing is written.
 */
import type pg from "pg";

import { Refusal } from "../refusal.js";
import { factsFor, withInitiativeFactsLock } from "../initiative-record.js";
import { safeName } from "../paths.js";
import { teamFor } from "../platform-db.js";
import { db } from "../platform-db.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { writeBranchFacts } from "./protocol.js";

/** `place` is resolved by the caller BEFORE this runs — `teamFor` queries the pool on a cache
 *  miss, and a query on the pool while the ledger's client is held is a second connection.
 *
 *  There is no store root: the fact this writes is a `zz.initiative_fact` row. */
export async function prepareWithBranchFact<T>(
  principal: string, tool: string, key: string, args: Record<string, unknown>,
  place: { readonly team: string; readonly initiative: string },
  releaseMode: "promotable" | "proposal_only",
  fn: (client: pg.PoolClient) => Promise<MutatorOutcome<T>>,
): Promise<{ readonly outcome: IdempotencyOutcome<T>; readonly facts: Record<string, string> }> {
  const { team, initiative } = place;
  const bad = safeName(initiative, "initiative");
  if (bad) throw new Refusal(bad);

  let facts: Record<string, string> | null = null;
  const outcome = await withInitiativeFactsLock(initiative, () => withIdempotency(
    principal, tool, key, args,
    async (client): Promise<MutatorOutcome<T>> => {
      const written = await fn(client);
      const decided = await writeBranchFacts(initiative, { release_mode: releaseMode }, { client, team });
      if (typeof decided === "string") throw new Refusal(decided);
      facts = decided;
      return written;
    },
  ));
  // A replay wrote nothing this time, so the fact its first call recorded is read back from the
  // row it landed in.
  const p = db();
  return { outcome, facts: facts ?? (p ? await factsFor(p, team, initiative) : {}) };
}

/** The team and initiative a branch fact is filed under, or a refusal naming what is missing.
 *
 *  A branch fact is a `zz.initiative_fact` row, and a row is filed against an initiative's own id
 *  — so a caller this deployment cannot place has no initiative to record one on, and that is
 *  refused before the ledger is touched rather than after.
 *
 *  DELIBERATE: the initiative's name is checked here too. `prepareWithBranchFact` checks it as
 *  well, and the two agree by construction because both call `safeName`; what this adds is that a
 *  bad name is refused before a team is looked up. */
export async function initiativePlace(
  principal: string, initiative: string,
): Promise<{ team: string; initiative: string } | string> {
  const bad = safeName(initiative, "initiative");
  if (bad) return bad;
  const team = await teamFor(principal);
  if (!team) {
    return "ERROR: this caller resolves to no team, so there is no initiative to record a " +
      "branch fact against.";
  }
  return { team, initiative };
}
