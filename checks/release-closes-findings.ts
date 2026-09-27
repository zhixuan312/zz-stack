#!/usr/bin/env node
// The provenance gap the ledger named: release_record never closed the findings its candidate was
// built to fix, so 21 applications were recorded only as prose inside decision_note. A release that
// landed is the evidence a plugin-owned finding was applied, and it should say so itself.
//
// It must go through the ONE exported deciding path, not a second private writer — that path lives in
// plugin-record.ts, which is why this task depends on I-31 rather than owning the file. The export's
// NAME is part of I-31's contract, so this can assert the name rather than a word that would match.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = "services/zz-core/src/eval/release-record.ts";
const src = readFileSync(SRC, "utf8");

assert.ok(/improvement_run_finding/.test(src),
  "the release finds the targeted findings through the relation, not through prose");
assert.ok(/from\s+["']\.\/plugin-record\.js["']/.test(src),
  "it imports the one exported deciding path rather than writing the decision itself");
assert.ok(/\bdecideFinding\b/.test(src),
  "and calls it by the name I-31's contract fixes — a second private writer has another name");

console.log("ok release-closes-findings");
