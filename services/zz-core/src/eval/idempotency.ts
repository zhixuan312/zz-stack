/**
 * The idempotency ledger (FR-59, AC-59.1): one row per `(principal, tool, idempotency_key)` in
 * `zz.eval_idempotency` (001), so a retried mutator call either replays the first
 * attempt's result or is refused as a conflict, and never re-runs a write it already made.
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
 *  it ahead of this function's sort. Mirrors tenant-info/policies.ts's `canonicalJson` — kept as
 *  its own copy rather than a shared import, because the two are canonicalizing different shapes
 *  (an arbitrary tool-argument object here, a fixed semantic payload there) and a shared helper
 *  would have to serve both without either owning it.
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
 *  request arriving again. Different digest → conflict: the primary key is `(principal, tool,
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

async function lookupRow(
  runner: Queryable,
  principal: string,
  tool: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const { rows } = await runner.query<{ request_digest: string; result_table: string; result_id: string }>(
    `select request_digest, result_table, result_id::text as result_id
       from zz.eval_idempotency
      where principal = $1 and tool = $2 and idempotency_key = $3`,
    [principal, tool, key],
  );
  return rows[0] ?? null;
}

function conflictRefusal(key: string, tool: string): Refusal {
  return new Refusal(`ERROR: idempotency_conflict — key ${key} was used for a different request by this principal on ${tool}`);
}

// Postgres's own code for "unique_violation" — the signal that this transaction lost a race to
// insert the ledger row, rather than any other reason the insert could fail.
const UNIQUE_VIOLATION = "23505";

/** The ledger's verdict on a request BEFORE a mutator does its slow work — for the tools that
 *  ask a model (`failure_discover`, `evaluator_qualify`, `evaluation_assess`). Those now ask outside the transaction, so without this a retry would
 *  re-ask every model before `withIdempotency` got to say "replay". Throws the same conflict
 *  refusal `withIdempotency` would. Advisory only: `withIdempotency` still decides again inside
 *  its transaction, so a race between this read and that one is settled there, never here. */
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
      await client.query(
        `insert into zz.eval_idempotency (principal, tool, idempotency_key, request_digest, result_table, result_id, created_at)
         values ($1, $2, $3, $4, $5, $6, now())`,
        [principal, tool, key, digest, outcome.result_table, outcome.result_id],
      );
    } catch (err) {
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
