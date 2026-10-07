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

// Public versions: the snapshot id stays `revision`, and the version a reader is shown is its own
// column, so several snapshots can share one version.
assert.deepEqual(col("doc_revision", "version")?.slice(1, 3), ["integer", false],
  "doc_revision.version is a NOT NULL integer — every snapshot belongs to a public version");
assert.ok((t("doc_revision").checks ?? []).some((c) => /version >= 1/.test(c)), "and versions start at 1");
assert.ok((t("doc_revision").indexes ?? []).some((i) => /\(doc_id, version\)/.test(i)),
  "a version read is served by an index on (doc_id, version)");
assert.deepEqual(col("doc", "current_version")?.slice(1, 3), ["integer", true], "doc.current_version is nullable");
assert.ok((t("doc").checks ?? []).some((c) => /\(current_version IS NULL\) = \(current_revision IS NULL\)/.test(c)),
  "and null exactly when current_revision is");
assert.deepEqual(col("doc", "content_generation"), ["content_generation", "bigint", false, "0"],
  "doc.content_generation is a NOT NULL bigint counter starting at 0");
// Every snapshot carries the generation it was written at, so a presented or approved one can be
// named by its own content revision; a row written before generations were recorded has none.
assert.deepEqual(col("doc_revision", "content_generation"), ["content_generation", "bigint", true, null],
  "doc_revision.content_generation is a nullable bigint with no default — never backfilled");
assert.equal(names("doc_revision").at(-1), "content_generation",
  "and last in ordinal order, because the release's migration adds it with ADD COLUMN");
// Causes are citations with an origin; a support never carries one.
assert.deepEqual(col("doc_link", "linked_by")?.slice(1, 3), ["text", true], "doc_link.linked_by is nullable text");
assert.ok((t("doc_link").checks ?? []).some((c) => /'agent'::text, 'platform'::text/.test(c)),
  "linked_by is agent or platform");
assert.ok((t("doc_link").checks ?? []).some((c) => /linked_by IS NULL\) OR \(kind = 'cites'/.test(c)),
  "and only a citation carries one");
// The request record is keyed by path, so a create's replay is found before the document exists.
assert.deepEqual(t("doc_request").primaryKey, ["team_id", "principal_id", "canonical_path", "request_id"],
  "doc_request is keyed by (team, principal, path, request_id)");
assert.equal((t("doc_request").foreignKeys ?? []).find((f) => f.columns.join() === "doc_id")?.onDelete, "CASCADE",
  "and goes with the document it names");
assert.ok((t("cause_link_epoch").indexes ?? []).some((i) => /UNIQUE INDEX .*\(\(true\)\)/.test(i)),
  "cause_link_epoch holds at most one row, by a unique index on a constant");

// A change receipt's complete details live on the change's own `document.*` event row: found by
// the reference a receipt prints, and kept as long as the receipt that names it.
assert.ok((t("event").indexes ?? []).some((i) => /\(detail ->> 'details_ref'::text\)/.test(i) && /WHERE \(detail \? 'details_ref'::text\)/.test(i)),
  "an event's details are found by an index on detail->>'details_ref', over the rows that carry one");
// A review context's coverage and the pin rule read one document's presentations, not the log.
assert.ok((t("event").indexes ?? []).some((i) => /event_shown_subject .*\(initiative_id, subject\) WHERE .*'document\.shown'::text, 'document\.shown_part'::text/.test(i)),
  "a document's presentations are found by a partial index on (initiative_id, subject) over the two shown kinds");
assert.ok(/retention=[^;]*document\.\*[^;]* kept indefinitely/.test(t("event").comment ?? ""),
  "zz.event's retention keeps document.* kinds indefinitely, like the audit kinds");
assert.ok(/document\.\* row written in the transaction of the change it records, whose failed insert fails that change/.test(t("event").comment ?? ""),
  "zz.event's comment says a document.* row written in its change's transaction fails the change when it fails");
assert.ok(/details_ref and details/.test(t("event").columnComments?.detail ?? ""),
  "zz.event.detail's comment names the details a document.* row may carry");

// An upload is staging, not authority: minted by upload_start, its bytes bound once by the
// gateway, consumed once by a write, and kept without its body so a used id is never new again.
assert.deepEqual(names("upload"), ["id", "team_id", "principal_id", "filename", "link_secret_hash", "created_at",
  "expires_at", "byte_count", "sha256", "body", "staged_via", "staged_by", "consumed_at", "consumed_by_operation", "consumed_digest"],
  "zz.upload carries the minted, staged and used columns, in the order its three writers fill them");
assert.deepEqual(t("upload").primaryKey, ["id"], "an upload is keyed by its id");
assert.ok((t("upload").uniques ?? []).some((u) => u.join() === "link_secret_hash"), "and found by its link secret's hash");
assert.deepEqual(col("upload", "body")?.slice(1, 3), ["bytea", true], "the staged body is nullable bytes, removed after use or expiry");
assert.equal(col("upload", "expires_at")?.[3], "(now() + '00:15:00'::interval)", "the staging window is 15 minutes");
for (const [re, why] of [
  [/staged_via = ANY \(ARRAY\['token'::text, 'link'::text\]\)/, "staged_via is token or link"],
  [/\(sha256 IS NULL\) = \(byte_count IS NULL\)\) AND \(\(sha256 IS NULL\) = \(staged_via IS NULL\)/, "a staging is bound whole"],
  [/\(staged_by IS NULL\) = \(\(staged_via IS NULL\) OR \(staged_via = 'link'::text\)\)/, "a link staging names no principal"],
  [/body IS NULL\) OR \(\(sha256 IS NOT NULL\) AND \(consumed_at IS NULL\)/, "a body exists only while staged and unused"],
  [/id ~ '\^up_\[a-z2-7\]\{26\}\$'/, "the id is up_ and 26 base32 characters"],
] as [RegExp, string][]) {
  assert.ok((t("upload").checks ?? []).some((c) => re.test(c)), why);
}
assert.ok((t("upload").indexes ?? []).some((i) => /upload_sweep .*\(expires_at\) WHERE \(body IS NOT NULL\)/.test(i)),
  "the hourly sweep finds the bodies still held by expiry");
assert.ok(/retention=.*hourly sweep/.test(t("upload").comment ?? ""), "zz.upload's retention names the hourly sweep");

assert.equal((SCHEMA_TARGET as { phase: number }).phase, 6,
  "the target says which phase it describes, and the rehearsal prints it");

console.log("ok store-shape");
