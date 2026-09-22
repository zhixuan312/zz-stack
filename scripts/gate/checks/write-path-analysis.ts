import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRowVector, bodyTsvParams } from "@zz/indexing";
import { root } from "../read.ts";
import { check } from "../run.ts";

check("new writes carry the analyzer's han terms and the row's own latin text, each to its own half", () => {
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
  if (v.analyzer !== "zz-lexical-v3") return `the write path recorded analyzer ${v.analyzer}`;

  // THE LATIN HALF IS THE ROW'S OWN TEXT, UNSPLIT, and this is the half that was wrong.
  //
  // `bodyTsvSql` runs `to_tsvector('english', $n)` over whatever `bodyTsvParams` binds at $n.
  // Binding the analyzer's already-split words there destroys every compound token
  // PostgreSQL's parser would have emitted, while the read path — which does not pre-split —
  // goes on asking for them:
  //
  //     to_tsvector('english','the sdlc-deck plan') -> 'deck':4 'plan':5 'sdlc':3 'sdlc-deck':2
  //     to_tsvector('english','sdlc deck plan')     -> 'deck':2 'plan':3 'sdlc':1
  //     websearch_to_tsquery('english','Plan: progressive sdlc-deck')
  //                                                 -> 'plan' & 'progress' & 'sdlc-deck' <-> 'sdlc' <-> 'deck'
  //
  // So the row looked indexed, the vector looked full, and the match was false. Measured on a
  // faithful copy of this deployment: 1002 of 1010 rows written before the pre-split
  // construction retrieved themselves by their own title, and 0 of the 23 written by it did.
  //
  // NOTHING IN THIS REPOSITORY ASKED THIS UNTIL NOW. 419 checks agreed, because every one of
  // them read the vector's own shape — its terms, its weights, its configuration names — and
  // the vector was internally perfect. The question none of them put is whether the text the
  // latin half is BUILT from is the text the read path QUERIES against.
  const title = "Plan: progressive sdlc-deck";
  const hyphen = buildRowVector({ title, tags: ["zz-core"], body: "the sdlc-deck plan" });
  const latin = bodyTsvParams(hyphen);
  if (latin[2] !== title) {
    return `the latin half of body_tsv is built from ${JSON.stringify(String(latin[2]).slice(0, 60))} `
         + `rather than the row's own title — every compound token PostgreSQL's parser would emit `
         + `is lost, while the read path's websearch_to_tsquery goes on asking for it`;
  }
  if (latin[4] !== "zz-core" || latin[6] !== "the sdlc-deck plan") {
    return "the latin half of the tags or body weight is not that field's own text, so the same compound loss applies there";
  }
  // THE HAN HALF IS STILL THE ANALYZER'S, which is the whole reason there are two halves —
  // asserted on the Chinese fixture above, since the hyphen fixture has no Han in it to carry.
  // PostgreSQL's parser reads an unspaced Han run as one opaque token and can produce none of
  // these unigrams, so a row whose han half came from the raw text would be exactly as
  // unfindable as the pre-v2 rows were.
  const han = bodyTsvParams(v);
  if (!String(han[3] ?? "").includes("迁") || !String(han[7] ?? "").includes("迁")) {
    return "the han half no longer carries the analyzer's unigrams, which PostgreSQL's parser cannot produce at all";
  }
  if (han[2] !== "迁移说明") return "the latin half is not the row's own title even when that title is Han";
});
