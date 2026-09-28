#!/usr/bin/env node
// Three relations were stored as text on this table: the shelf as a slug, the successor as a bare
// ordinal resolved by LIKE, and the evidence as initiative slugs — of which 58 point at another
// team's shelf and one is ambiguous, because a slug is team-scoped and an identity is not. `path`
// held two facts in one column, and the spec's Data model splits it. What this asserts is that no
// statement names the retired columns and that each replacement has a writer. A name-scan over
// prose would be a check that cannot pass, so it reads statement literals only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const retired = ["team_slug", "path", "superseded_by", "evidence"];
const files = execFileSync("git", ["ls-files", "services", "packages"], { encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") && !f.includes("/dist/"));

const sqlLiterals = (src: string): string[] =>
  [...src.matchAll(/(["'`])([^"'`]*\b(?:select\s[\s\S]*?\bfrom\b|insert\s+into\b|update\s+[a-z_.]+\s+set\b|delete\s+from\b)[^"'`]*)\1/gi)]
    .map((m) => m[2]);

const hits: string[] = [];
for (const f of files) {
  for (const sql of sqlLiterals(readFileSync(f, "utf8"))) {
    // A bare name is a node column only when the statement binds the node table.
    if (!/\bknowledge_node\b/i.test(sql)) continue;
    for (const c of retired) {
      if (new RegExp(`(?:^|[\\s,.(])${c}\\b`, "i").test(sql)) hits.push(`${f}: knowledge_node.${c} in a statement`);
    }
  }
}
assert.deepEqual(hits, [], "no statement names a column this phase retires");

// Each replacement has a writer, or the reshape is a rename that wrote nothing. The writer is
// `packages/indexing/src/index.ts` — `indexNode`/`supersedeNode`, the one pair that writes a
// knowledge node now that `indexDoc` is gone with the file store.
const indexer = readFileSync("packages/indexing/src/index.ts", "utf8");
for (const [what, re] of [["team_id", /team_id/], ["node_ordinal", /node_ordinal|nodeOrdinal/],
                          ["slug", /slug/], ["superseded_by_id", /superseded_by_id|supersededById/]] as const) {
  assert.ok(re.test(indexer), `the node writer names ${what}`);
}
assert.ok(/knowledge_node_evidence/.test(indexer), "the node writer writes the evidence relation");
assert.ok(/knowledge_node_evidence/.test(readFileSync("services/zz-core/src/tools/knowledge-search.ts", "utf8")),
  "the neighbour lane reads it");

console.log("ok knowledge-node-ids");
