#!/usr/bin/env node
// Thirteen projections of a file record that exists on no live store, and the three default
// partitions that made them usable before any corpus did. The ledger is what decided their removal:
// every one holds zero rows in production, nothing in production reaches them, and the design they
// implement stays approved and restorable from git. What this asserts is the TARGET, where a table
// either exists or does not, plus the shape the spec's Data model fixes for knowledge_node — the
// plan followed an earlier reading of it and was re-pointed.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const gone = ["artifact", "artifact_revision", "artifact_event", "artifact_edge", "artifact_passage",
              "artifact_identifier", "artifact_projection_commit", "artifact_projection_watermark",
              "doc_artifact", "knowledge_node_artifact", "search_current", "search_evidence",
              "search_history", "search_current_default", "search_evidence_default",
              "search_history_default"];
for (const t of gone) assert.ok(!SCHEMA_TARGET.tables[t], `the target no longer declares ${t}`);

const node = SCHEMA_TARGET.tables["knowledge_node"];
assert.ok(node, "knowledge_node stays");
const cols = (node.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
for (const c of ["team_id", "node_ordinal", "slug", "superseded_by_id", "content_hash",
                 "body_tsv", "analyzer_version", "created_at", "updated_at"]) {
  assert.ok(cols.includes(c), `knowledge_node.${c} stands, as the spec's Data model lists it`);
}
for (const c of ["team_slug", "path", "superseded_by", "evidence"]) {
  assert.ok(!cols.includes(c), `knowledge_node.${c} is retired by item 17`);
}
// The AC says the FIFTEEN columns the spec names and nothing else, so the set is asserted
// rather than the nine this used to spot-check.
assert.deepEqual(cols.slice().sort(), ["analyzer_version", "body", "body_tsv", "content_hash",
  "created_at", "id", "kind", "lifecycle", "node_ordinal", "slug", "superseded_by_id", "tags",
  "team_id", "title", "updated_at"], "knowledge_node is the fifteen columns item 17 lists");

const evidence = SCHEMA_TARGET.tables["knowledge_node_evidence"];
assert.ok(evidence, "the evidence relation is a table");
const ecols = (evidence.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
assert.deepEqual(ecols.slice().sort(), ["initiative_id", "node_id"],
  "it is the two keys and nothing else — no team column, because a node may cite another team");

// AC-4.2: the index that makes a Chinese substring match an index scan rather than a seq scan.
// The target carries indexes as their own `CREATE INDEX` statements rather than as field objects,
// so this reads the statement — the shape is the tree's, not one I chose.
const indexed = (t: string): boolean =>
  ((SCHEMA_TARGET.tables[t]?.indexes ?? []) as string[])
    .some((i) => /USING\s+gin\b/i.test(i) && /\bbody\b/i.test(i));
assert.ok(indexed("knowledge_node"), "knowledge_node.body carries a gin index");
assert.ok(indexed("doc"), "doc.body carries the same one");

console.log("ok artifact-layer-removed");
