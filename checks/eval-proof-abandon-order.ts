#!/usr/bin/env node
// Round-3 review (finding 3): candidate_prove(abandon) revokes the verifier_token FIRST, on its
// own commit, then cancels what it spawned, and counts the allocation's runs INSIDE the resolving
// transaction — after locking the token rows, so a replay_start whose run insert is in flight is
// waited for and counted. Reading "any proof run exists" before the revoke let a replay_start in
// the gap draw a sealed case while the split was released. Driven against a stubbed pg.Pool.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const ALLOC = "70000000-0000-4000-8000-000000000001";
type Result = { rows: Record<string, unknown>[]; rowCount: number };
const statements: { on: "pool" | "tx"; sql: string; values: unknown[] }[] = [];
let runsExist = false;

function answer(sql: string): Result {
  if (/^update zz\.replay_verifier_token .* returning id/.test(sql)) return { rows: [{ id: ALLOC }], rowCount: 1 };
  if (/from zz\.replay_run rr/.test(sql)) return { rows: [], rowCount: 0 }; // nothing live left to cancel
  if (/from zz\.eval_idempotency/.test(sql)) return { rows: [], rowCount: 0 };
  if (/^update zz\.candidate set status/.test(sql)) return { rows: [], rowCount: 1 };
  if (/select exists .* from zz\.replay_run/.test(sql)) return { rows: [{ any: runsExist }], rowCount: 1 };
  if (/insert into zz\.candidate_evaluation/.test(sql)) return { rows: [{ id: "e0000000-0000-4000-8000-000000000001" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
const record = (on: "pool" | "tx", text: string, values: unknown[] = []) => {
  const sql = text.replace(/\s+/g, " ").trim();
  statements.push({ on, sql, values });
  return answer(sql);
};
pg.Pool.prototype.connect = (async function connect() {
  return { async query(text: string, values?: unknown[]) { return record("tx", text, values); }, release() {} };
}) as unknown as typeof pg.Pool.prototype.connect;
pg.Pool.prototype.query = (async function query(text: string, values?: unknown[]) {
  return record("pool", text, values);
}) as unknown as typeof pg.Pool.prototype.query;

const { abandonProof } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/candidate-prove-abandon.js")).href);
const { db } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/platform-db.js")).href);

const candidate = {
  id: "c0000000-0000-4000-8000-000000000001", status: "proving",
  improvement_run_id: "10000000-0000-4000-8000-000000000001", touched_owners: [],
};

for (const executed of [true, false]) {
  statements.length = 0;
  runsExist = executed;
  const out = await abandonProof(db(), candidate, `abandon-${executed}`, "owner@example.test");
  const at = (on: "pool" | "tx", re: RegExp) => statements.findIndex((s) => s.on === on && re.test(s.sql));

  const revoke = at("pool", /^update zz\.replay_verifier_token set revoked_at = now\(\) .* returning id/);
  const cancel = at("pool", /from zz\.replay_run rr/);
  const begin = at("tx", /^BEGIN$/);
  const lock = at("tx", /from zz\.replay_verifier_token where id = any\(.*\) for update/);
  const count = at("tx", /select exists .* from zz\.replay_run where verifier_allocation_id = any/);
  assert.ok(revoke >= 0 && revoke < cancel, "the token is revoked, on its own statement, before anything is cancelled");
  assert.ok(cancel < begin, "runs are cancelled before the resolving transaction");
  assert.ok(begin < lock && lock < count, "the runs are counted inside the transaction, after locking the token rows");
  assert.deepEqual(statements[count].values, [[ALLOC]], "counted for the allocation the revoke returned");
  assert.ok(!statements.slice(0, revoke).some((s) => /replay_run/.test(s.sql)), "nothing reads the runs before the revoke");

  const evaluation = statements.find((s) => /insert into zz\.candidate_evaluation/.test(s.sql));
  assert.equal(JSON.parse(String(evaluation?.values[4])).proof_runs_executed, executed, "the statistics record the in-transaction count");
  const releasesSplit = statements.some((s) => /update zz\.replay_case_set set proof_spent_at = null/.test(s.sql));
  assert.equal(releasesSplit, !executed, executed ? "a run executed: the split stays spent" : "no run: the split is released");
  assert.equal(out.proof_split, executed ? "spent" : "released");
  assert.equal(out.reason, "abandoned");
}

console.log("ok eval-proof-abandon-order");
process.exit(0);
