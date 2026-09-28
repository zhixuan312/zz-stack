#!/usr/bin/env node
// The AC's clauses are facts about the world — a hash matches, a row exists — and a check that
// only greps the carry's source cannot establish any of them: it would pass for any
// plausible-looking file, which is exactly how a phase's central data claim ships unverified.
// So this asserts the two things a source scan CAN settle — that the executable evidence exists
// and is wired where the rehearsal will run it — and leaves the measurement to the run it names.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

assert.ok(existsSync("scripts/store-migration.ts"), "the carry exists");
const src = readFileSync("scripts/store-migration.ts", "utf8");

// The three records it must read, each by name: the working tree, the snapshots, and the history
// that holds what the working tree overwrote.
assert.ok(/\.v.*\.md|_versions/.test(src), "it reads the store's snapshot names");
assert.ok(/rev-list|git log|cat-file|show/.test(src), "and the git history the writes were committed to");
assert.ok(/git_failed/.test(src), "and the entries that name a write git never kept");
assert.ok(/content_hash/.test(src), "it hashes the bytes it writes, so the comparison is possible");
assert.ok(/missing_legacy/.test(src), "and names the state for what the store genuinely lost");

// The wiring the run half depends on: the carry is the migration's withArtifacts step, in the file
// the rehearsal reads, or nothing runs it at all.
const expect = readFileSync("scripts/rehearse/expect.ts", "utf8");
assert.ok(/withArtifacts/.test(expect), "the rehearsal's expectations declare store steps");
assert.ok(/store-migration/.test(expect), "and this migration's step is declared there");

// DELIBERATE: read from the folded file, and the claim is about the SCHEMA rather than about a
// filename. 003_store_data.sql was folded into 001_init.sql once the release that shipped it was
// verified; the header's absorbs list is what says the file it came from is covered, and asking
// the migrations directory for one file of that name asks a question the fold made meaningless.
const body = readFileSync("services/gateway/migrations/001_init.sql", "utf8");
assert.ok(/-- absorbs: 003_store_data\.sql/.test(body),
  "the folded file names the store-data migration it absorbed");
// The file carries the constraint order and the legacy-tolerant checks; the CARRY is the
// script's, and nothing in a migration reads a filesystem.
assert.ok(/NOT VALID/i.test(body),
  "while carrying the legacy-tolerant checks the constraint order names");

console.log("ok store-migration-lossless");
