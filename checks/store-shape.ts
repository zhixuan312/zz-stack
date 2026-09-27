#!/usr/bin/env node
// The three shapes phase 6 turns on, asserted against the TARGET rather than a migrated catalog,
// because the target is what the migration is written to match. Two facts here are easy to get
// wrong and expensive: the constraint names are entries in a table's `checks` array and not tables
// of their own, and the deferrable key is the one on `current_revision` BY NAME — asserting that
// "some revision key is deferrable" would pass on a tree where the wrong one is.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
type Col = [string, string, boolean, string | null];
type T = { columns?: Col[]; primaryKey?: string[] | null; checks?: string[];
           foreignKeys?: { columns: string[]; refTable: string; onDelete: string; deferrable: boolean }[];
           uniques?: string[][]; indexes?: string[]; comment?: string | null;
           columnComments?: Record<string, string> };
const t = (n: string): T => (SCHEMA_TARGET.tables[n] ?? {}) as T;
const names = (n: string) => (t(n).columns ?? []).map((c) => c[0]);
const col = (n: string, c: string): Col | undefined => (t(n).columns ?? []).find((x) => x[0] === c);

// doc: the columns item 13 fixes.
for (const c of ["id", "initiative_id", "path", "type", "status", "current_revision",
                 "approved_revision", "title", "body", "tags", "content_hash", "body_tsv",
                 "analyzer_version", "created_at", "updated_at"]) {
  assert.ok(names("doc").includes(c), `doc.${c} stands`);
}
assert.equal(col("doc", "initiative_id")?.[2], false, "doc.initiative_id is NOT NULL");
assert.deepEqual(t("doc").primaryKey, ["id"], "doc's key is its id, not the three columns it retires");
const initKey = (t("doc").foreignKeys ?? []).find((f) => f.columns.includes("initiative_id"));
assert.ok(initKey, "doc.initiative_id still references initiative");
assert.equal(initKey?.onDelete, "CASCADE",
  "and cascades — a NOT NULL column cannot carry the SET NULL it has today");
const cur = (t("doc").foreignKeys ?? []).find((f) => f.columns.includes("current_revision"));
assert.ok(cur && cur.deferrable === true, "doc.current_revision's key is DEFERRABLE, by name");
assert.equal(cur?.refTable, "doc_revision", "and references the revision table");
// The status/revision agreement lives on doc, in its checks array.
assert.ok((t("doc").checks ?? []).some((c) => /approved_revision/.test(c)),
  "doc.checks carries the status/revision agreement");

// doc_revision: item 14.
for (const c of ["doc_id", "revision", "content_state", "title", "body", "tags", "content_hash",
                 "written_by", "written_at", "revision_note", "approved_by", "approved_at"]) {
  assert.ok(names("doc_revision").includes(c), `doc_revision.${c} stands`);
}
assert.ok((t("doc_revision").checks ?? []).some((c) => /content_state/.test(c)),
  "doc_revision.checks carries the content-state contract, which is what forbids invented bytes");
assert.ok((t("doc_revision").uniques ?? []).some((u) => u.includes("doc_id") && u.includes("revision")),
  "one revision number per document");

// doc_link: item 15, whose grain the kind decides.
for (const c of ["from_doc_id", "from_revision", "to_doc_id", "to_revision", "kind"]) {
  assert.ok(names("doc_link").includes(c), `doc_link.${c} stands`);
}
assert.ok((t("doc_link").checks ?? []).some((c) => /kind/.test(c)), "doc_link.kind is constrained");

assert.equal((SCHEMA_TARGET as { phase: number }).phase, 6,
  "the target says which phase it describes, and the rehearsal prints it");

console.log("ok store-shape");
