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
// The column, and the key that makes it a finding of the SAME run: group G identifies a finding
// inside its eval_run, so the self-reference is composite. Phase 4's migration declared both, and
// it folded back into `001_init.sql` once release 0.85.0 was verified in production, so the
// declaration that now carries the answer is the folded baseline. The question is unchanged — the
// supersede is a same-run key — asked of the declaration instead of the `alter table` that
// introduced it.
//
// DELIBERATE: lower-cased once, here. `001_init.sql` is `pg_dump` output and `pg_dump` spells
// every keyword in upper case (`ADD CONSTRAINT`, `UNIQUE`, `FOREIGN KEY`); the clauses below are
// written in the case SQL is normally written in.
const schema = readFileSync("services/gateway/migrations/001_init.sql", "utf8").toLowerCase();

/** The text of one `<name>` constraint clause, up to the `;` that closes it. The declaration
 *  states a check inline on its `create table` and every key as a later `alter table … add
 *  constraint`; `add constraint` is tried first because the inline spelling is a substring of it. */
function constraint(name: string): string | null {
  const added = schema.indexOf(`add constraint ${name} `);
  const at = added >= 0 ? added : schema.indexOf(`constraint ${name} `);
  if (at < 0) return null;
  const end = schema.indexOf(";", at);
  return end < 0 ? schema.slice(at) : schema.slice(at, end);
}

// Was `assert.match(schema, /alter table zz\.eval_finding\s*\n\s*add constraint
// eval_finding_eval_run_id_id_key unique \(eval_run_id, id\);/)` against the migration's own
// statement. The clause is read exactly now rather than matched loosely, so a key that lost its
// column list, gained one, or changed a column is a failure and not a near miss.
assert.equal(constraint("eval_finding_eval_run_id_id_key"),
  "add constraint eval_finding_eval_run_id_id_key unique (eval_run_id, id)",
  "a finding is identified inside its run");
// Was the same `assert.match` shape against `…add constraint
// eval_finding_eval_run_id_superseded_by_fkey foreign key (eval_run_id, superseded_by) references
// zz.eval_finding(eval_run_id, id);`. The declaration states it as `ALTER TABLE ONLY … ADD
// CONSTRAINT`, which the lower-casing and the helper above read back to the same clause.
assert.equal(constraint("eval_finding_eval_run_id_superseded_by_fkey"),
  "add constraint eval_finding_eval_run_id_superseded_by_fkey foreign key (eval_run_id, superseded_by) " +
  "references zz.eval_finding(eval_run_id, id)",
  "superseded_by points at another finding of that same run");
// The half the composite key exists to retire: the folded baseline may not go on carrying the
// single-column self-reference, or a supersede would resolve across runs through it again.
assert.ok(!schema.includes("constraint eval_finding_superseded_by_fkey "),
  "the single-column self-reference is gone, not carried beside the composite one");
console.log("ok eval-finding-supersede");
