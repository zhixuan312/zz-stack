#!/usr/bin/env node
// Group G's nine tables, and the keys the spec names for them. The key assertions are STRUCTURAL —
// read off `SCHEMA_TARGET`, whose `foreignKeys` carry columns/refTable/refColumns/onDelete — and not
// off the migration's text: a text pattern fails correct work (the inline `unique … references … on
// delete cascade` form, a comment between the clauses) and passes wrong work (a cascade on another
// column inside the window), and `sdlc-execute` freezes this check before the migration is written,
// so it must name the key rather than recognise one spelling of it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
interface Fk { columns: string[]; refTable: string; refColumns: string[]; onDelete: string }
const t = (n: string) => SCHEMA_TARGET.tables[n];
const cols = (n: string) => (t(n)?.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
const hasUnique = (n: string, key: string[]): boolean =>
  (t(n)?.uniques ?? []).some((u: string[]) => key.every((c) => u.includes(c)) && u.length === key.length);
const hasFk = (n: string, key: string[], refTable: string, refCols: string[], onDelete: string): boolean =>
  ((t(n)?.foreignKeys ?? []) as Fk[]).some((f) => f.refTable === refTable && f.onDelete === onDelete
    && key.every((c) => f.columns.includes(c)) && refCols.every((c) => f.refColumns.includes(c)));

for (const name of ["eval_finding", "improvement_run", "improvement_run_finding", "candidate",
                    "release_attempt", "release_attempt_owner", "control_run", "control_evidence",
                    "control_waiver"]) {
  assert.ok(t(name), `the target declares ${name}`);
}

// The two relation tables exist, and the columns that held the relations are gone.
for (const [table, gone] of [["improvement_run", "finding_ids"], ["release_attempt", "required_owners"],
                             ["candidate", "touched_owners"], ["release_attempt", "approval_refs"],
                             ["release_attempt", "rolled_back"], ["control_evidence", "note"]] as const) {
  assert.ok(!cols(table).includes(gone), `${table}.${gone} is a relation or a duplicate now, not a column`);
}
for (const gone of ["team_slug", "initiative", "module_id", "subject", "profile"]) {
  assert.ok(!cols("control_run").includes(gone), `control_run.${gone} is dropped`);
}

// Keyed by the initiative, with the cascade that sweeps a deleted one.
assert.ok(cols("control_run").includes("initiative_id"), "control_run carries initiative_id");
assert.ok(hasUnique("control_run", ["initiative_id"]), "control_run's initiative_id is unique");
assert.ok(hasFk("control_run", ["initiative_id"], "initiative", ["id"], "CASCADE"),
  "and its foreign key cascades, so a deleted initiative takes its run");

// A fact of a run is identified inside that run, and a withdrawal resolves inside it too.
assert.ok(hasUnique("control_evidence", ["run_id", "entry_id"]), "control_evidence is unique per run and entry");
assert.ok(hasFk("control_evidence", ["run_id", "supersedes"], "control_evidence", ["run_id", "entry_id"], "NO ACTION"),
  "a withdrawal points at an entry of its own run");
assert.ok(hasUnique("eval_finding", ["eval_run_id", "id"]), "a finding is identified inside its run");
assert.ok(hasFk("eval_finding", ["eval_run_id", "superseded_by"], "eval_finding", ["eval_run_id", "id"], "NO ACTION"),
  "and a correction points at a finding of that same run");

// The drops and renames, on the target side — the other half of a reshape that no check asserted.
for (const gone of ["eval_id", "docs_affected", "proposed_change", "resulted_in_skill_version_id", "scope"]) {
  assert.ok(!cols("eval_finding").includes(gone), `eval_finding.${gone} is dropped`);
}
for (const gone of ["patchset", "touched_owners", "proposer_identity", "base_subject_version_id"]) {
  assert.ok(!cols("candidate").includes(gone), `candidate.${gone} is dropped or renamed`);
}
assert.ok(cols("candidate").includes("patch") && cols("candidate").includes("proposed_by")
  && cols("candidate").includes("base_plugin_version_id"), "candidate carries the names group G gives it");
for (const gone of ["base_subject_version_id", "released_subject_version_id", "approved_patch_digest",
                    "required_owners", "approval_refs", "rolled_back"]) {
  assert.ok(!cols("release_attempt").includes(gone), `release_attempt.${gone} is dropped`);
}
assert.ok(cols("release_attempt").includes("released_plugin_version_id"), "release_attempt names the released version");
for (const col of ["verdict", "verified_at", "verification"]) {
  assert.ok(cols("release_attempt").includes(col), `release_attempt.${col} stands`);
}

console.log("ok improve-control-shape");
