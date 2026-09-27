#!/usr/bin/env node
// Round-3 review (finding 2): release_prepare/proposal_prepare's ledger row and branch fact are
// written on ONE pooled connection. The facts lock used to be a session advisory lock held on a
// connection of its own for the whole call while withIdempotency took a second, so four
// concurrent prepares starved the four-connection pool. Driven here against a stubbed pg.Pool
// that counts connections: a prepare holds exactly one, takes the transaction-level advisory lock
// and writes the fact mirror on it, never queries the pool while holding it, and concurrent
// prepares on one initiative never hold two between them. The mirror row is keyed by the
// initiative's own id, resolved once per call — asserted here, because a slug written into a uuid
// column is a row the console cannot join. A conflicting fact rolls everything back.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

type Result = { rows: Record<string, unknown>[]; rowCount: number };
const statements: { on: "pool" | number; sql: string; values: unknown[] }[] = [];
let outstanding = 0;
let maxOutstanding = 0;
let connects = 0;
let poolQueriesWhileHeld = 0;

// COUPLED: the fixture is ROWS, not files. A branch fact is a `zz.initiative_fact` row keyed by
// the initiative's own id, so the stub serves the id resolution, the fact read and the fact write
// from one map — and the check can still assert that the id the resolver handed over is the one
// the insert was written with.
const IDS: Record<string, string> = {
  "init-a": "b0000000-0000-4000-8000-000000000001",
  "init-b": "b0000000-0000-4000-8000-000000000002",
};
const factsBySlug: Record<string, Record<string, string>> = {};
const slugOfId = (id: string): string | undefined => Object.keys(IDS).find((s) => IDS[s] === id);

function answer(sql: string, values: unknown[] = []): Result {
  if (/from zz\.eval_idempotency/.test(sql)) return { rows: [], rowCount: 0 };
  if (/insert into zz\.release_attempt/.test(sql)) return { rows: [{ id: "a0000000-0000-4000-8000-000000000001" }], rowCount: 1 };
  // `initiativeIdFor` (initiative-record.ts): the fact row is keyed by the initiative's own id, so
  // this lookup stands between the initiative's name and the row.
  if (/select i\.id::text as id from zz\.initiative i/.test(sql)) {
    const id = IDS[String(values[1])];
    return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
  }
  // `factsFor`: the branch facts this initiative already carries.
  if (/from zz\.initiative_fact f/.test(sql)) {
    return { rows: Object.entries(factsBySlug[String(values[1])] ?? {})
      .map(([fact, value]) => ({ fact, value })), rowCount: 0 };
  }
  // `writeFacts`: append-only, and the row is the record.
  if (/insert into zz\.initiative_fact/.test(sql)) {
    const slug = slugOfId(String(values[0]));
    if (slug) factsBySlug[slug] = { ...(factsBySlug[slug] ?? {}), [String(values[1])]: String(values[2]) };
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
const tick = () => new Promise((r) => setTimeout(r, 2));

pg.Pool.prototype.connect = (async function connect() {
  const id = ++connects;
  outstanding += 1;
  maxOutstanding = Math.max(maxOutstanding, outstanding);
  let released = false;
  return {
    async query(text: string, values?: unknown[]) {
      const sql = text.replace(/\s+/g, " ").trim();
      statements.push({ on: id, sql, values: values ?? [] });
      await tick();
      return answer(sql, values ?? []);
    },
    release() {
      assert.ok(!released, "a client released twice");
      released = true;
      outstanding -= 1;
    },
  };
}) as unknown as typeof pg.Pool.prototype.connect;
pg.Pool.prototype.query = (async function query(text: string) {
  if (outstanding) poolQueriesWhileHeld += 1;
  statements.push({ on: "pool", sql: text.replace(/\s+/g, " ").trim(), values: [] });
  return answer(text, []);
}) as unknown as typeof pg.Pool.prototype.query;

const { prepareWithBranchFact } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-prepare.js")).href);

const reset = () => { statements.length = 0; connects = 0; maxOutstanding = 0; poolQueriesWhileHeld = 0; };
const insertAttempt = async (client: { query(sql: string): Promise<Result> }) => {
  const row = (await client.query("insert into zz.release_attempt (candidate_id) values ('c') returning id::text as id")).rows[0];
  return { result: { id: String(row.id) }, result_table: "zz.release_attempt", result_id: String(row.id) };
};
const prepare = (initiative: string, key: string) => prepareWithBranchFact(
  "owner@example.test", "release_prepare", key, { candidate_id: "c", initiative },
  { team: "xuan", initiative }, "promotable", insertAttempt);
const facts = (initiative: string) => factsBySlug[initiative] ?? {};

  // One prepare: one connection, the lock and the mirror on it, nothing on the pool meanwhile.
  reset();
  const one = await prepare("init-a", "k1");
  assert.equal(connects, 1, "a prepare takes exactly one connection");
  assert.equal(maxOutstanding, 1);
  assert.equal(poolQueriesWhileHeld, 0, "no query on the pool while the ledger's client is held");
  assert.equal(outstanding, 0, "the connection is released");
  const sqls = statements.map((s) => s.sql);
  assert.ok(statements.every((s) => s.on === 1), "every statement runs on the ledger transaction's client");
  const at = (re: RegExp) => sqls.findIndex((s) => re.test(s));
  assert.ok(at(/^BEGIN$/) < at(/pg_advisory_xact_lock/), "the advisory lock is transaction-level, inside BEGIN");
  assert.ok(at(/insert into zz\.initiative_fact/) > at(/pg_advisory_xact_lock/), "the mirror is written under the lock");
  assert.ok(at(/insert into zz\.eval_idempotency/) < at(/^COMMIT$/));
  assert.ok(!sqls.some((s) => /pg_advisory_lock\(|pg_advisory_unlock/.test(s)), "no session-level advisory lock");
  // The mirror is keyed by the initiative's own id: the row is written with the id the resolver
  // read back, and the columns are the id, the fact and its value — no team or initiative slug.
  const mirror = statements.find((s) => /insert into zz\.initiative_fact/.test(s.sql));
  assert.ok(mirror, "the fact is mirrored");
  assert.match(mirror.sql, /insert into zz\.initiative_fact \(initiative_id, fact, value\)/,
    `the mirror writes by id: ${mirror.sql}`);
  assert.deepEqual(mirror.values, [IDS["init-a"], "release_mode", "promotable"],
    "the mirrored row carries the resolved id, the fact and its value");
  assert.equal(one.outcome.replayed, false);
  assert.deepEqual(one.facts, { release_mode: "promotable" });
  assert.deepEqual(facts("init-a"), { release_mode: "promotable" });

  // Five concurrent prepares on one initiative: the in-process queue means they never hold two
  // connections between them, so they cannot starve the pool waiting on each other's lock.
  reset();
  await Promise.all(["k2", "k3", "k4", "k5", "k6"].map((k) => prepare("init-a", k)));
  assert.equal(connects, 5);
  assert.equal(maxOutstanding, 1, "concurrent prepares on one initiative hold one connection at a time");
  assert.equal(poolQueriesWhileHeld, 0);

  // A conflicting fact: refused, rolled back, nothing committed and the file untouched.
  factsBySlug["init-b"] = { release_mode: "proposal_only" };
  reset();
  await assert.rejects(prepare("init-b", "k7"), /release_mode is already proposal_only/);
  const conflictSqls = statements.map((s) => s.sql);
  assert.ok(conflictSqls.includes("ROLLBACK") && !conflictSqls.includes("COMMIT"), "the refusal rolls the attempt row back");
  assert.ok(!conflictSqls.some((s) => /insert into zz\.eval_idempotency/.test(s)), "no ledger row");
  assert.deepEqual(facts("init-b"), { release_mode: "proposal_only" });
  assert.equal(outstanding, 0);

  // An unopened initiative: refused inside the transaction, rolled back the same way.
  reset();
  await assert.rejects(prepare("init-missing", "k8"), /no initiative named "init-missing"/);
  assert.ok(!statements.some((s) => s.sql === "COMMIT"));

console.log("ok eval-release-prepare-connection");
process.exit(0);
