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

// The migration file carries only what must land with the data, so a fresh database still migrates.
const sql = "services/gateway/migrations";
const named = (await import("node:fs")).readdirSync(sql).filter((f: string) => /store_data\.sql$/.test(f));
assert.equal(named.length, 1, "exactly one store-data migration");
const body = readFileSync(`${sql}/${named[0]}`, "utf8");
assert.ok(!/\.md|readFileSync|artifacts/i.test(body), "and it reads no filesystem: the carry is the script's");
assert.ok(/NOT VALID/i.test(body), "while carrying the legacy-tolerant checks the constraint order names");

console.log("ok store-migration-lossless");
