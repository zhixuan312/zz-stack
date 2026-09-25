#!/usr/bin/env node
// Round-3 review (finding 2): release_prepare/proposal_prepare's ledger row and branch fact are
// written on ONE pooled connection. The facts lock used to be a session advisory lock held on a
// connection of its own for the whole call while withIdempotency took a second, so four
// concurrent prepares starved the four-connection pool. Driven here against a stubbed pg.Pool
// that counts connections: a prepare holds exactly one, takes the transaction-level advisory lock
// and writes the fact mirror on it, never queries the pool while holding it, and concurrent
// prepares on one initiative never hold two between them. A conflicting fact rolls everything back.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

type Result = { rows: Record<string, unknown>[]; rowCount: number };
const statements: { on: "pool" | number; sql: string }[] = [];
let outstanding = 0;
let maxOutstanding = 0;
let connects = 0;
let poolQueriesWhileHeld = 0;

function answer(sql: string): Result {
  if (/from zz\.eval_idempotency/.test(sql)) return { rows: [], rowCount: 0 };
  if (/insert into zz\.release_attempt/.test(sql)) return { rows: [{ id: "a0000000-0000-4000-8000-000000000001" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
const tick = () => new Promise((r) => setTimeout(r, 2));

pg.Pool.prototype.connect = (async function connect() {
  const id = ++connects;
  outstanding += 1;
  maxOutstanding = Math.max(maxOutstanding, outstanding);
  let released = false;
  return {
    async query(text: string) {
      const sql = text.replace(/\s+/g, " ").trim();
      statements.push({ on: id, sql });
      await tick();
      return answer(sql);
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
  statements.push({ on: "pool", sql: text.replace(/\s+/g, " ").trim() });
  return answer(text);
}) as unknown as typeof pg.Pool.prototype.query;

const { prepareWithBranchFact } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-prepare.js")).href);

const root = mkdtempSync(join(tmpdir(), "zz-prepare-conn-"));
const reset = () => { statements.length = 0; connects = 0; maxOutstanding = 0; poolQueriesWhileHeld = 0; };
const insertAttempt = async (client: { query(sql: string): Promise<Result> }) => {
  const row = (await client.query("insert into zz.release_attempt (candidate_id) values ('c') returning id::text as id")).rows[0];
  return { result: { id: String(row.id) }, result_table: "zz.release_attempt", result_id: String(row.id) };
};
const prepare = (initiative: string, key: string) => prepareWithBranchFact(
  "owner@example.test", "release_prepare", key, { candidate_id: "c", initiative },
  { root, team: "xuan", initiative }, "promotable", insertAttempt);
const facts = (initiative: string) => JSON.parse(readFileSync(join(root, initiative, "_facts.json"), "utf8"));

try {
  // One prepare: one connection, the lock and the mirror on it, nothing on the pool meanwhile.
  mkdirSync(join(root, "init-a"));
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
  mkdirSync(join(root, "init-b"));
  writeFileSync(join(root, "init-b", "_facts.json"), `${JSON.stringify({ release_mode: "proposal_only" })}\n`);
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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("ok eval-release-prepare-connection");
process.exit(0);
