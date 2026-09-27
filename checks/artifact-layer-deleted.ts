#!/usr/bin/env node
// The layer is gone from the tree, not renamed to something quieter. Every name below was a table a
// projection wrote, or the extension its BM25 index needed; a statement or an import naming one is
// a file that survived the deletion. Comments are not statements, so this reads imports and
// statement literals — and it says plainly what must stay, so a later reader does not "finish" the
// job by removing the trigram extension AC-4.2 depends on.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const retiredTables = ["artifact", "artifact_revision", "artifact_event", "artifact_edge", "artifact_passage",
  "artifact_identifier", "artifact_projection_commit", "artifact_projection_watermark",
  "doc_artifact", "knowledge_node_artifact", "search_current", "search_evidence", "search_history"];
const files = execFileSync("git", ["ls-files", "services", "packages", "scripts", "testing", "deploy", "checks"],
  { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|sh|sql)$/.test(f) && !f.includes("/dist/"));

const hits: string[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const t of retiredTables) {
    if (new RegExp(`(?:import|from|join|into|update|delete\\s+from)\\s+[^\\n]*\\b${t}\\b`, "i").test(src)) {
      hits.push(`${f} still names ${t}`);
    }
  }
  // The layer's own files must not exist at all, whatever they say.
  if (/(?:^|\/)(?:tenant-projections|tenant-rebuild|search-plan|tenant-information)\.ts$/.test(f)) {
    hits.push(`${f} is a layer file that survived`);
  }
  // No `\b` before it: `_` is a word character, so `\bpg_textsearch\b` cannot see
  // `pg_textsearch_tag` — and that is where the extension actually lives, in the deploy
  // lock, the Dockerfile, the cluster conf and the two checks that pin them. The exemption
  // is per LINE too, because a whole-file one skipped the baseline on the word "deleted"
  // in an absorbs line while it still declared the extension.
  // The DATABASE's extension is dropped; the IMAGE's build and preload are not. `deploy/postgres`
  // compiles it and `shared_preload_libraries` loads it, and `checks/postgres-image-pinned.ts`
  // asserts the lock's tag reaches the image tag — so those mentions must stay, and a scan that
  // flagged them would demand deleting the pinned image build.
  // Two exemptions, each a file that must name the extension to say what it says: the deploy
// side compiles and preloads it, and THIS file states the rule — a scan that flagged either
// would demand deleting the pinned image build or its own explanation.
const namesItOnPurpose = /^(deploy\/postgres\/|checks\/postgres-image-pinned\.ts$|scripts\/gate\/checks\/deploy-compose\.ts$|checks\/artifact-layer-deleted\.ts$|services\/gateway\/migrations\/00[12][a-z_]*\.sql$)/;
if (namesItOnPurpose.test(f)) continue;
    src.split("\n").forEach((line, n) => {
    if (!/pg_textsearch/.test(line)) return;
    if (/remov|deleted|phase 5|absorb|no longer/i.test(line)) return;
    hits.push(`${f}:${n + 1} still names the pg_textsearch extension`);
  });
}
assert.deepEqual(hits, [], "the layer's tables, its files and its extension are gone from the tree");

// What must SURVIVE, asserted so the deletion is not overshot.
for (const kept of ["packages/indexing/src/tenant-analysis.ts",
                    "services/zz-core/src/tools/search-predicate.ts"]) {
  assert.ok(readFileSync(kept, "utf8").length > 0, `${kept} survives — the old path needs it`);
}

console.log("ok artifact-layer-deleted");
