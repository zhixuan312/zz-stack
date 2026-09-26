#!/usr/bin/env node
// A completed eval_run's score is published and is never scored again. The live door let a
// completed run be scored a second time under a new idempotency key, overwriting the published
// result (2 of 15 production runs were). A re-score is a new eval_run; a retry under the key
// that completed the run still replays through the FR-59 ledger.
// The write is read from source, since no database is available here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("services/zz-core/src/eval/evaluate.ts", "utf8");
const score = src.slice(src.indexOf('"evaluation_score",'));
assert.ok(score.length < src.length, "evaluation_score is registered in evaluate.ts");
const handler = score.slice(score.indexOf("async ({ eval_run_id, idempotency_key, initiative })"));

// Refused before any work, unless the ledger says this is the call that completed it.
const gate = handler.indexOf('run.run_status === "completed"');
assert.ok(gate > 0, "a completed run is recognised before scoring");
assert.ok(gate < handler.indexOf("loadDimensions("), "the refusal comes before any scoring work");
assert.match(handler.slice(gate, gate + 300),
  /decideBeforeWork\(principal, "evaluation_score", idempotency_key, \{ eval_run_id \}\)\)\.replayed/,
  "a retry under the completing key is recognised as a replay first, with the same ledger args withIdempotency digests");
assert.match(handler, /withIdempotency\(\s*principal, "evaluation_score", idempotency_key, \{ eval_run_id \}/,
  "the ledger args the replay check digests are the ones the write records");
assert.match(handler, /is already completed and its score is ` \+\s*"published[\s\S]*?A re-score is a new eval_run/,
  "the refusal names the run and says a re-score is a new eval_run");

// Guarded at the write as well: a concurrent score under another key cannot overwrite either.
assert.match(handler, /where id = \$1::uuid and run_status <> 'completed'`/,
  "the score write only lands on a run not yet completed");
assert.match(handler, /if \(written\.rowCount !== 1\) throw new Refusal\(alreadyScored\)/,
  "a write that found the run already completed refuses and rolls back, leaving no ledger row");
console.log("ok eval-score-once");
