/**
 * The idempotency ledger (FR-59, AC-59.1): one row per `(principal_id, tool, idempotency_key)` in
 * `zz.eval_idempotency` (001), so a retried mutator call either replays the first
 * attempt's result or is refused as a conflict, and never re-runs a write it already made.
 *
 * KEYED TO THE PRINCIPAL, NOT TO THE ADDRESS: the phase-3 migration replaced the `principal`
 * email text with `principal_id uuid not null` and re-keyed the primary key to
 * `(principal_id, tool, idempotency_key)`. Every caller here still names its caller
 * by the email address the door resolved, so the address is what this module is given and
 * `zz.principal` is what turns it into the key the table now holds. The lookup joins through that
 * table; the insert resolves the id in its own `values`, so a caller the platform has no principal
 * row for cannot be recorded at all — and the migrated table says so by refusing the row rather
 * than by accepting a string no principal answers to. That refusal is turned into the named
 * refusal below (`noPrincipalRefusal`) rather than propagating as a bare constraint error.
 *
 * DELIBERATE: the address is NOT resolved by a statement of its own, ahead of the lookup. A
 * separate `select id from zz.principal …` would refuse an unknown caller earlier — before `fn`
 * has done its writes — but it costs a statement on every mutator call for a case the insert
 * already refuses, and the fake pool `checks/eval-release-prepare-connection.ts` drives this
 * module through answers an unrecognised statement with no rows, so a lookup that read "no row"
 * as "no such principal" would refuse a caller that check proves is legitimate. The lookup below
 * is therefore driven through `zz.principal` and reads "no row" as "this caller has no ledger row
 * under this key", which is true of an unknown caller too; the insert is where an unknown caller
 * is refused.
 *
 * `withIdempotency` is the transactional wrapper every mutator added from here on calls before
 * doing its own writes: it decides proceed/replay/conflict from the ledger, and — only on
 * `proceed` — hands the caller a client so the ledger insert and the mutator's own write commit
 * together or not at all. It uses `db()` from `../platform-db.js`, the one pool this service
 * connects through everywhere else, rather than opening a second one.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

/** Hand-built, not `JSON.stringify` over a key-sorted object: a caller-controlled args object can
 *  carry an integer-looking string key, and V8's own object key iteration would silently reorder
 *  it ahead of this function's sort. The tenant-information layer had a second one beside its own
 *  semantic payload, and this was kept as its own copy rather than a shared import because the two
 *  canonicalized different shapes. That layer is gone, so this is the tree's only `canonicalJson`:
 *  a caller's arbitrary tool-argument object, and nothing else canonicalizes.
 *
 *  Exported for observe.ts (Task I-7): `evidence_digest` is sha256 over this same canonical form
 *  of the computed facts, so two callers who agree on the facts agree on the digest whatever
 *  order their own code happened to build the object in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return "null"; // undefined, function, symbol — none of these reach here from parsed JSON args
}

/** sha256 hex of a tool's argument object, independent of key order and of the
 *  `idempotency_key` field itself. The key is excluded so that two requests differing only in
 *  which key they happened to be sent under are still recognised as the same request — the
 *  digest is what decides "same request", the key is only where the ledger row lives. */
export function requestDigest(args: Record<string, unknown>): string {
  const { idempotency_key: _idempotency_key, ...rest } = args;
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

/** The shape `zz.eval_idempotency` stores and reads back — never the tool's actual result, only
 *  where to find it. Replaying a mutator means telling it which row its own first write already
 *  produced, not re-serving a cached response body this table never holds. A caller of
 *  `withIdempotency` never sees a ledger row, only the `MutatorOutcome`/`IdempotencyOutcome` it
 *  hands back. */
interface IdempotencyRow {
  readonly request_digest: string;
  readonly result_table: string;
  readonly result_id: string;
}

/** Not exported: it is `idempotencyDecision`'s own
 *  return shape, inlined into its signature. A caller of `withIdempotency` gets `proceed` folded
 *  into the ordinary call and `replay`/`conflict` turned into a result or a thrown `Refusal`; it
 *  never receives one of these directly and so never needs to name the type. */
type IdempotencyDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "replay"; readonly result_table: string; readonly result_id: string }
  | { readonly kind: "conflict" };

/** Pure: what a stored ledger row (or its absence) means for this request's digest.
 *  No row → proceed, this key has never been used. Same digest → replay; this is the same
 *  request arriving again. Different digest → conflict: the primary key is `(principal_id, tool,
 *  idempotency_key)`, not the digest, so a second, different request reusing the same key can
 *  never share the first request's row — it is refused instead of overwriting it. */
export function idempotencyDecision(existing: IdempotencyRow | null, digest: string): IdempotencyDecision {
  if (!existing) return { kind: "proceed" };
  if (existing.request_digest === digest) {
    return { kind: "replay", result_table: existing.result_table, result_id: existing.result_id };
  }
  return { kind: "conflict" };
}

/** What `fn` hands back to `withIdempotency`: the tool's own result to return to its caller, and
 *  where its first write landed — the two columns the ledger row exists to remember. */
export interface MutatorOutcome<T> {
  readonly result: T;
  readonly result_table: string;
  readonly result_id: string;
}

/** What `withIdempotency` hands back: `fn`'s result on a fresh request, or, on a replay, the same
 *  `result_table`/`result_id` reference `idempotencyDecision` would have returned — the mutator
 *  that called `withIdempotency` is the one that knows how to turn that reference back into a
 *  response, because only it knows `result_table`'s shape. */
export type IdempotencyOutcome<T> =
  | { readonly replayed: false; readonly result: T }
  | { readonly replayed: true; readonly result_table: string; readonly result_id: string };

// The one shape `lookupRow` needs from either a pool or a client already inside a transaction —
// `pg.Pool` and `pg.PoolClient` both satisfy it structurally, and a shared interface avoids the
// non-callable union TypeScript would otherwise infer from `Pick<Pool | PoolClient, "query">`.
interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

// Postgres's own code for "unique_violation" — the signal that this transaction lost a race to
// insert the ledger row, rather than any other reason the insert could fail.
const UNIQUE_VIOLATION = "23505";
// And for "not_null_violation", which on this table's `principal_id` is the unresolvable caller.
const NOT_NULL_VIOLATION = "23502";

async function lookupRow(
  runner: Queryable,
  principal: string,
  tool: string,
  key: string,
): Promise<IdempotencyRow | null> {
  // Driven through `zz.principal` rather than from the ledger: the table is keyed by a principal
  // id and the caller names an address, so the join is what turns one into the other. `principal_id`
  // carries a foreign key to `zz.principal(id)`, so the join can never drop a row that exists.
  //
  // No row therefore means "no ledger row for this caller under this (tool, key)" — which is the
  // same answer for a caller the platform has no principal row for, since such a caller cannot have
  // a ledger row either. That case is refused by the insert below, not here: see the module note.
  const { rows } = await runner.query<{ request_digest: string; result_table: string; result_id: string }>(
    `select i.request_digest, i.result_table, i.result_id::text as result_id
       from zz.eval_idempotency i
       join zz.principal p on p.id = i.principal_id
      where lower(p.email) = lower($1) and i.tool = $2 and i.idempotency_key = $3`,
    [principal, tool, key],
  );
  return rows[0] ?? null;
}

/** The one statement that writes a ledger row. The principal is resolved in the `values` list, so
 *  a caller the platform has no `zz.principal` row for gives a null in a `not null` column and the
 *  migrated table refuses the row — which `ledgerRefusal` below turns into a named refusal. It is
 *  resolved here rather than read back from a lookup because the lookup is allowed to find nothing
 *  (see `lookupRow`), and a value that must be there is not one to carry across a statement that
 *  may answer with no rows. `$1` is the caller's email; the columns after it are in the order
 *  `withIdempotency` binds them. */
const INSERT_LEDGER_ROW = `
  insert into zz.eval_idempotency
    (principal_id, tool, idempotency_key, request_digest, result_table, result_id, created_at)
  values ((select p.id from zz.principal p where lower(p.email) = lower($1)), $2, $3, $4, $5, $6, now())`;

function conflictRefusal(key: string, tool: string): Refusal {
  return new Refusal(`ERROR: idempotency_conflict — key ${key} was used for a different request by this principal on ${tool}`);
}

/** The refusal a caller with no `zz.principal` row gets, named rather than left as the constraint
 *  error the migrated table raises: the ledger is keyed to the principal that made the call, and a
 *  caller the platform does not know is not a caller this ledger can hold an entry for. */
function noPrincipalRefusal(principal: string): Refusal {
  return new Refusal(
    `ERROR: "${principal}" resolves to no principal, so a call it made cannot be recorded — the ` +
    "ledger is keyed to the principal row that made the call, not to the address it was called from",
  );
}

/** Whether a ledger insert failed because the caller names no principal, or null for any other
 *  fault. `23502` on `principal_id` is exactly that case: the id comes from the subquery above and
 *  the column is `not null`, so a null there can mean nothing else. It is matched by column and not
 *  by code alone, because every other column of this table is `not null` too, and a fault in one of
 *  those is not an unknown caller. */
function ledgerRefusal(err: unknown, principal: string): Refusal | null {
  const e = err as { code?: string; column?: string };
  return e.code === NOT_NULL_VIOLATION && e.column === "principal_id" ? noPrincipalRefusal(principal) : null;
}

/** The ledger's verdict on a request BEFORE a mutator does its slow work — for the tools that
 *  ask a model (`failure_discover`, `evaluator_qualify`, `evaluation_assess`). Those now ask outside the transaction, so without this a retry would
 *  re-ask every model before `withIdempotency` got to say "replay". Throws the same conflict
 *  refusal `withIdempotency` would. Advisory only: `withIdempotency` still decides again inside
 *  its transaction, so a race between this read and that one is settled there, never here.
 *
 *  DELIBERATE: an address no principal answers to reads as `proceed` here, and is refused by the
 *  insert inside `withIdempotency` instead. This read is the one that has to stay cheap — it runs
 *  on the path that asks models — and a caller with no principal row is refused by the table's own
 *  `not null` rather than by a statement this read would add to every mutator call. See the module
 *  note for why the resolution is not a statement of its own. */
export async function decideBeforeWork(
  principal: string, tool: string, key: string, args: Record<string, unknown>,
): Promise<{ readonly replayed: false } | { readonly replayed: true; readonly result_table: string; readonly result_id: string }> {
  if (!key || !key.trim()) throw new Refusal("ERROR: idempotency_key required");
  const pool = db();
  if (!pool) throw new Refusal("ERROR: this deployment has no platform database, so nothing can be recorded");
  const decision = idempotencyDecision(await lookupRow(pool, principal, tool, key), requestDigest(args));
  if (decision.kind === "conflict") throw conflictRefusal(key, tool);
  if (decision.kind === "replay") return { replayed: true, result_table: decision.result_table, result_id: decision.result_id };
  return { replayed: false };
}

/** The transactional wrapper every mutator calls instead of writing directly. `principal` and
 *  `tool` name who is calling and what they are calling; `key` is the caller-supplied
 *  idempotency key; `args` is the tool's full argument object, digested exactly as
 *  `requestDigest` digests it elsewhere so the two never disagree about what "the same request"
 *  means. `fn` receives the transaction's own client — not the pool — so its first write and the
 *  ledger insert below are one commit.
 *
 *  `principal` is the caller's own email address — what the door resolved — and `principal_id` is
 *  the key the migrated table holds; `INSERT_LEDGER_ROW` is what turns one into the other. A caller
 *  the platform has no principal row for is refused by name, and `fn`'s write goes back with it.
 *
 *  Order of operations matters here: the ledger row cannot be inserted before `fn` runs, because
 *  `result_table`/`result_id` are `fn`'s own write's identity and do not exist until it has run.
 *  So the transaction is: decide from what is already stored, run `fn`, insert the ledger row,
 *  commit — never insert-then-run, which would have nothing to point `result_id` at if inserted
 *  first and would leave a dangling row if `fn` then failed.
 *
 *  `fn` holds one of the pool's few connections for as long as it runs: it must do database
 *  writes only, never a model call, and never a query on the pool (a second connection while the
 *  first is held is how the pool starves). Ask first, then call this. */
export async function withIdempotency<T>(
  principal: string,
  tool: string,
  key: string,
  args: Record<string, unknown>,
  fn: (client: pg.PoolClient) => Promise<MutatorOutcome<T>>,
): Promise<IdempotencyOutcome<T>> {
  if (!key || !key.trim()) throw new Refusal("ERROR: idempotency_key required");

  const pool = db();
  if (!pool) throw new Refusal("ERROR: this deployment has no platform database, so nothing can be recorded");

  const digest = requestDigest(args);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await lookupRow(client, principal, tool, key);
    const decision = idempotencyDecision(existing, digest);
    if (decision.kind === "conflict") {
      await client.query("ROLLBACK");
      throw conflictRefusal(key, tool);
    }
    if (decision.kind === "replay") {
      await client.query("ROLLBACK"); // nothing was written on this call — the earlier one already committed
      return { replayed: true, result_table: decision.result_table, result_id: decision.result_id };
    }

    const outcome = await fn(client);

    try {
      await client.query(INSERT_LEDGER_ROW, [principal, tool, key, digest, outcome.result_table, outcome.result_id]);
    } catch (err) {
      const unresolvable = ledgerRefusal(err, principal);
      if (unresolvable) {
        // The migrated table refused the row because the caller names no principal. `fn`'s own
        // write goes back with it: a call the ledger cannot hold an entry for is a call this
        // service does not record, and half of it committed would be the worse answer.
        await client.query("ROLLBACK");
        throw unresolvable;
      }
      // Lost the race: a concurrent call with the same (principal, tool, key) committed its own
      // ledger row first. Its own write (and this one's) resolve to one winner by the primary
      // key — this is the loser, so it rolls back its own write and re-reads the winner's row
      // rather than erroring a request that a twin actually satisfied.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        await client.query("ROLLBACK");
        const winner = await lookupRow(pool, principal, tool, key);
        const redecision = idempotencyDecision(winner, digest);
        if (redecision.kind === "replay") {
          return { replayed: true, result_table: redecision.result_table, result_id: redecision.result_id };
        }
        // The winner's row is for a different digest under the same key — a genuine conflict
        // between two concurrent callers, not a replay of this one.
        throw conflictRefusal(key, tool);
      }
      throw err;
    }

    await client.query("COMMIT");
    return { replayed: false, result: outcome.result };
  } catch (err) {
    // ROLLBACK is idempotent against a transaction already ended above (conflict, replay, and the
    // unique-violation branch all end it themselves before reaching here); this only matters for
    // an error `fn` itself threw, or any other unexpected failure, with the transaction still open.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
