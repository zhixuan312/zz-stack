import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRowVector } from "@zz/indexing";
import { root } from "../read.ts";
import { check } from "../run.ts";

check("new writes are analysed by the analyzer, not by a prose text-search configuration", () => {
  const src = readFileSync(join(root, "packages/indexing/src/index.ts"), "utf8");
  // Both INSERTs must build `body_tsv` from the shared construction. Reading the source rather
  // than the SQL string: the failure this guards against is a statement that goes back to
  // re-parsing the raw prose columns, and a prose configuration tokenizes on whitespace and
  // punctuation, so an unspaced Han run goes in as one opaque word and comes out as nothing a
  // query can hit. `text-search-config-agreement.ts` separately forbids naming a configuration
  // here at all; this asserts the statements are actually wired to the analyzer's terms.
  const wired = src.match(/\$\{bodyTsvSql\(\d+\)\}/g) ?? [];
  if (wired.length !== 2) {
    return `index.ts builds body_tsv from bodyTsvSql in ${wired.length} of its 2 INSERTs, so a `
         + `newly written document is indexed by something other than the analyzer — the backfill `
         + `in I-13 would fix the corpus that exists and nothing written after it`;
  }
  const bound = src.match(/\.\.\.bodyTsvParams\(\w+\)/g) ?? [];
  if (bound.length !== 2) {
    return `index.ts binds bodyTsvParams in ${bound.length} of its 2 INSERTs; a statement whose `
         + `parameters do not come from the same construction as its SQL cannot execute at all`;
  }
  // `terms` is a list of { term, weight } — an earlier form of this check read it as both a
  // string list and an object list in adjacent lines, which no implementation could satisfy.
  const v = buildRowVector({ title: "迁移说明", tags: ["迁移"], body: "这个迁移会破坏旧的模式" });
  if (!v.terms.some((t) => t.term === "迁")) return "the write-path vector carries no base term for 迁; a query for 迁移 cannot match it";
  const weights = new Set(v.terms.map((t) => t.weight));
  for (const w of ["A", "B", "C"]) if (!weights.has(w)) return `the write-path vector lost weight ${w}`;
  if (v.analyzer !== "zz-lexical-v2") return `the write path recorded analyzer ${v.analyzer}`;
});
