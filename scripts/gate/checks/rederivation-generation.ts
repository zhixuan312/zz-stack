import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRowVector, planRebuild, queryGeneration, rebuildRowVector } from "@zz/indexing";
import { root } from "../read.ts";
import { check } from "../run.ts";

check("rederivation covers old rows and refuses to mix analyzer generations", () => {
  const p = planRebuild({ analyzer: "zz-lexical-v2", previous: "zz-lexical-v1" });
  for (const c of ["zz.doc", "zz.knowledge_node"]) {
    if (!p.corpora.includes(c)) return `${c} is not in the rebuild plan, so its existing rows keep v1 terms`;
  }
  if (p.skipUnchangedContentHash) {
    return "the rebuild skips rows whose content hash is unchanged — but the analyzer changed and the hash did not, "
         + "so every old Chinese document would stay invisible";
  }
  const mixed = queryGeneration({ indexGeneration: "zz-lexical-v1", queryGeneration: "zz-lexical-v2" });
  if (mixed.status === "ok") return "a one-sided analyzer upgrade reported ok; a complete empty would be indistinguishable from no match";
  if (!["index_not_ready", "incomplete", "compatible_pair"].includes(mixed.status)) {
    return `a one-sided upgrade reported ${mixed.status}, which does not disclose the mismatch`;
  }
  if (!p.resumable) return "the rebuild declares no watermark, so an interrupted run cannot resume";

  // ONE CONSTRUCTION, TWO CALLERS — never two implementations of the same weighting. Checked
  // two ways, because neither alone is enough: the rebuild module must literally import the
  // write path's builder, AND the two must agree on a row. An earlier form of this check
  // demanded `rebuildRowVector === buildRowVector`, which forces an alias export and makes the
  // agreement test dead code — requiring exactly the dormant code this plan forbids.
  const rebuildSrc = readFileSync(join(root, "packages/indexing/src/tenant-rebuild.ts"), "utf8");
  if (!/import\s*\{[^}]*\bbuildRowVector\b/.test(rebuildSrc)) {
    return "tenant-rebuild.ts does not import buildRowVector — a second implementation of the same "
         + "weighting is how the write path and the backfill drifted apart in the first place";
  }
  const row = { title: "迁移说明", tags: ["迁移"], body: "这个迁移会破坏旧的模式" };
  if (JSON.stringify(rebuildRowVector(row)) !== JSON.stringify(buildRowVector(row))) {
    return "the rebuild and the write path produce different vectors for the same row";
  }
});
