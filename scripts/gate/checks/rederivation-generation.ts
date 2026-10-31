import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRowVector, rebuildRowVector } from "@zz/indexing";
import { root, withoutComments} from "../read.ts";
import { check } from "../run.ts";

// One construction, two callers — never two implementations of the same weighting. Checked two
// ways, because neither alone is enough: the rederivation module must literally import the write
// path's builder, and the two must agree on a row.
//
// DELIBERATE: this does not demand `rebuildRowVector === buildRowVector`. Identity forces an alias
// export and makes the agreement test below dead code.
check("the rebuild and the write path build a row's vector with one implementation", () => {
  const rebuildSrc = withoutComments(readFileSync(join(root, "packages/indexing/src/rederivation.ts"), "utf8"));
  if (!/import\s*\{[^}]*\bbuildRowVector\b/.test(rebuildSrc)) {
    return "rederivation.ts does not import buildRowVector — a second implementation of the same "
         + "weighting is how the write path and the backfill drifted apart in the first place";
  }
  const row = { title: "迁移说明", tags: ["迁移"], body: "这个迁移会破坏旧的模式" };
  if (JSON.stringify(rebuildRowVector(row)) !== JSON.stringify(buildRowVector(row))) {
    return "the rebuild and the write path produce different vectors for the same row";
  }
});
