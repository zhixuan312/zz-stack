#!/usr/bin/env node
// Round-6 follow-up: release_prepare and proposal_prepare take only the initiative, so
// PROMOTE/VERIFY can open in a fresh conversation. The eval_run comes from <initiative>/findings.md's
// own frontmatter; release_prepare's candidate is the one proof_passed candidate of that eval_run's
// improvement runs — refused by name when there is none or more than one — and proposal_prepare's
// run is the newest (a fresh improvement_start after a not_established proof supersedes the older).
// Driven against a stubbed pg.Pool; the store read is the pure evalRunIn.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const RUN = "e0000000-0000-4000-8000-000000000001";
let rows: Record<string, unknown>[] = [];
const seen: { sql: string; values: unknown[] }[] = [];
pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  seen.push({ sql: text.replace(/\s+/g, " ").trim(), values });
  return { rows, rowCount: rows.length };
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { evalRunIn, proofPassedCandidateOn, improvementRunOn } = await load("services/zz-core/dist/eval/initiative-run.js");
const { db } = await load("services/zz-core/dist/platform-db.js");
const { registerReleaseTools } = await load("services/zz-core/dist/eval/release.js");

// ---- the eval_run, from findings.md's frontmatter.
assert.equal(evalRunIn(`---\ntitle: Findings\neval_run_id: ${RUN}\n---\n# Findings\n`, "i1"), RUN);
assert.match(evalRunIn(null, "i1").error, /^ERROR: no_eval_run — i1\/findings\.md does not exist/);
assert.match(evalRunIn("---\ntitle: Findings\n---\n# x\n", "i1").error, /no_eval_run/);

// ---- release_prepare's candidate: exactly one proof_passed, on this eval_run.
rows = [];
assert.match((await proofPassedCandidateOn(db(), "i1", RUN)).error, /^ERROR: not_eligible — no candidate of i1's improvement runs/);
const lookup = seen.at(-1)!;
assert.match(lookup.sql, /join zz\.improvement_run ir on ir\.id = c\.improvement_run_id where ir\.eval_run_id = \$1::uuid and c\.status = 'proof_passed'/);
assert.deepEqual(lookup.values, [RUN]);
rows = [{ id: "c1" }];
assert.equal(await proofPassedCandidateOn(db(), "i1", RUN), "c1");
rows = [{ id: "c1" }, { id: "c2" }];
assert.match((await proofPassedCandidateOn(db(), "i1", RUN)).error, /^ERROR: ambiguous_candidate — 2 candidates .*\(c1, c2\)/);

// ---- proposal_prepare's run: the newest on this eval_run, refused when there is none.
rows = [];
assert.match((await improvementRunOn(db(), "i1", RUN)).error, /^ERROR: no_improvement_run/);
rows = [{ id: "r2" }];
assert.equal(await improvementRunOn(db(), "i1", RUN), "r2");
assert.match(seen.at(-1)!.sql, /where eval_run_id = \$1::uuid order by created_at desc limit 1/);

// ---- both tools take the initiative and nothing else that names a candidate or a run.
const schemas = new Map<string, Record<string, unknown>>();
registerReleaseTools({ registerTool(name: string, def: { inputSchema: Record<string, unknown> }) { schemas.set(name, def.inputSchema); } });
assert.deepEqual(Object.keys(schemas.get("release_prepare")!).sort(), ["idempotency_key", "initiative"]);
assert.deepEqual(Object.keys(schemas.get("proposal_prepare")!).sort(), ["idempotency_key", "initiative"]);

console.log("eval-prepare-from-initiative: release_prepare and proposal_prepare resolve what they act on from the initiative");
process.exit(0);
