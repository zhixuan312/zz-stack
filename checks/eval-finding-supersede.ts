#!/usr/bin/env node
// A recorded finding can be corrected. The live zz-core evaluation recorded 7.5 where the score
// said 7.7 and had no way to fix it. finding_record(supersedes) closes the wrong one in the same
// write, and findings.md renders only the current one, noting what it corrected.
// The render is pure; the write is read from source, since no database is available here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { renderFindings } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/findings-doc.js")).href);

const row = (id: string, pattern: string, superseded_by: string | null, decision = "deferred") =>
  ({ id, kind: "strength", pattern, owner_kind: "plugin", owner_ref: null, evidence_refs: [], decision, decision_note: null, superseded_by });
const md = renderFindings([
  row("old-id", "reliability scored 7.5", "new-id", "rejected"),
  row("new-id", "reliability scored 7.7", null),
  row("other-id", "tool refusals explain themselves", null),
], "strength");
assert.ok(!md.includes("- reliability scored 7.5"), "the superseded finding is not rendered as current");
assert.match(md, /- reliability scored 7\.7 .*corrects `old-id`, which said: "reliability scored 7\.5"/, "its correction says what it corrected");
assert.match(md, /- tool refusals explain themselves/);
assert.equal(md.split("\n").length, 2, "one line per current finding");

// The write: the old finding closes in the same transaction the correction lands in, guarded.
const src = readFileSync("services/zz-core/src/eval/plugin-record.ts", "utf8");
assert.match(src, /supersedes: z\.string\(\)\.optional\(\)/, "finding_record takes supersedes");
assert.match(src, /set superseded_by = \$2::uuid, decision = 'rejected'[\s\S]*?where id = \$1::uuid and decision = 'deferred' and superseded_by is null/,
  "the old finding is closed as rejected-and-superseded, only if still open");
assert.match(src, /old\.eval_run_id !== eval_run_id/, "a correction stays in its own eval_run");
// The column: 001_init.sql is a pg_dump of the schema, so it spells the column and its foreign key apart.
const schema = readFileSync("services/gateway/migrations/001_init.sql", "utf8");
assert.match(schema, /CREATE TABLE zz\.eval_finding \([^;]*\n    superseded_by uuid,?\n/, "eval_finding has superseded_by");
assert.match(schema, /ALTER TABLE ONLY zz\.eval_finding\n    ADD CONSTRAINT eval_finding_superseded_by_fkey FOREIGN KEY \(superseded_by\) REFERENCES zz\.eval_finding\(id\);/,
  "superseded_by points at another finding");
console.log("ok eval-finding-supersede");
