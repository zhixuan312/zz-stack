#!/usr/bin/env node
// A scored eval_run's score is published and is never scored again. The live door let a scored
// run be scored a second time under a new idempotency key, overwriting the published result (2
// of 15 production runs were). A re-score is a new eval_run; a retry under the key that scored
// the run still replays through the FR-59 ledger.
//
// `scored_at` is the terminal marker now — the phase-3 reshape replaced `run_status` with it, so
// a run is finished exactly when it has one. The write is read from source, since no database is
// available here; `checks/scored-run-terminal.ts` is the other half, which proves by exact text
// that no statement anywhere rewrites a scored run's columns.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("services/zz-core/src/eval/evaluate.ts", "utf8");
const at = src.indexOf("export async function scoreEvaluation");
assert.ok(at > 0, "scoreEvaluation is exported from evaluate.ts and is where the score is written");
const rest = src.slice(at);
const next = rest.indexOf("\nexport ", 1);
const fn = next > 0 ? rest.slice(0, next) : rest;

// Refused before any work, unless the ledger says this is the call that scored it.
const gate = fn.indexOf("run.scored_at !== null");
assert.ok(gate > 0, "a scored run is recognised by its own terminal marker");
assert.ok(gate < fn.indexOf("loadDimensions("), "the refusal comes before any scoring work");
assert.match(fn.slice(gate, gate + 400),
  /decideBeforeWork\(principal, "evaluation_score", idempotency_key, \{ eval_run_id \}\)\)\.replayed/,
  "a retry under the scoring key is recognised as a replay first, with the same ledger args withIdempotency digests");
assert.match(fn, /withIdempotency\(\s*principal, "evaluation_score", idempotency_key, \{ eval_run_id \}/,
  "the ledger args the replay check digests are the ones the write records");
assert.match(fn, /is already scored and its score is ` \+\s*"published[\s\S]*?A re-score is a new eval_run/,
  "the refusal names the run and says a re-score is a new eval_run");

// Guarded at the write as well: a concurrent score under another key cannot overwrite either.
assert.match(fn, /where id = \$1::uuid and scored_at is null`/,
  "the score write only lands on a run with no published result");
assert.match(fn, /if \(written\.rowCount !== 1\) throw new Refusal\(alreadyScored\)/,
  "a write that found the run already scored refuses and rolls back, leaving no ledger row");
console.log("ok eval-score-once");
