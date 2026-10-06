import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRowVector, bodyTsvParams } from "@zz/indexing";
import { root, withoutComments } from "../read.ts";
import { check } from "../run.ts";

check("new writes carry the analyzer's han terms and the row's own latin text, each to its own half", () => {
  // COUPLED: EVERY statement that assigns `body_tsv` must build it from the shared construction,
  // and there are two files to hold: `packages/indexing/src/index.ts` writes a journal node's row,
  // and `services/zz-core/src/document-save.ts` writes a document's. Read from the source rather than
  // the SQL string: the failure guarded against is a statement that goes back to re-parsing the
  // raw prose columns, where a prose configuration tokenizes on whitespace and punctuation and an
  // unspaced Han run goes in as one opaque word.
  //
  // Counted per file and compared, rather than pinned to a number: what has to hold is that no
  // statement assigns the column by any other route, and a count that drifts with the number of
  // write paths is one somebody updates instead of reading.
  // Counted against the column's own name: a statement that writes `body_tsv` and does not build
  // it from `bodyTsvSql` is the failure, and the two counts are equal exactly when there is none.
  // A count pinned to a number instead would drift with the number of write paths, and somebody
  // would update it rather than read it.
  const WRITERS = ["packages/indexing/src/index.ts", "services/zz-core/src/document-save.ts"];
  for (const rel of WRITERS) {
    const src = withoutComments(readFileSync(join(root, rel), "utf8"));
    const names = (src.match(/\bbody_tsv\b/g) ?? []).length;
    const wired = (src.match(/bodyTsvSql\(\d+\)/g) ?? []).length;
    if (names === 0) return `${rel} names body_tsv nowhere — this check reads nothing there`;
    if (wired !== names) {
      return `${rel} builds body_tsv from bodyTsvSql in ${wired} of its ${names} SQL mentions of `
           + `the column, so a newly written row is indexed by something other than the analyzer — `
           + `the backfill in I-13 would fix the corpus that exists and nothing written after it`;
    }
    if (!/bodyTsvParams\(/.test(src)) {
      return `${rel} binds no bodyTsvParams; a statement whose parameters do not come from the same `
           + `construction as its SQL cannot execute at all`;
    }
  }
  // `terms` is a list of { term, weight }, never a list of strings.
  const v = buildRowVector({ title: "迁移说明", tags: ["迁移"], body: "这个迁移会破坏旧的模式" });
  if (!v.terms.some((t) => t.term === "迁")) return "the write-path vector carries no base term for 迁; a query for 迁移 cannot match it";
  const weights = new Set(v.terms.map((t) => t.weight));
  for (const w of ["A", "B", "C"]) if (!weights.has(w)) return `the write-path vector lost weight ${w}`;
  if (v.analyzer !== "zz-lexical-v3") return `the write path recorded analyzer ${v.analyzer}`;

  // The latin half is the row's own text, unsplit. `bodyTsvSql` runs `to_tsvector('english', $n)`
  // over whatever `bodyTsvParams` binds at $n, and binding the analyzer's already-split words
  // there destroys every compound token PostgreSQL's parser would have emitted, while the read
  // path — which does not pre-split — goes on asking for them:
  //
  //     to_tsvector('english','the sdlc-deck plan') -> 'deck':4 'plan':5 'sdlc':3 'sdlc-deck':2
  //     to_tsvector('english','sdlc deck plan')     -> 'deck':2 'plan':3 'sdlc':1
  //     websearch_to_tsquery('english','Plan: progressive sdlc-deck')
  //                                                 -> 'plan' & 'progress' & 'sdlc-deck' <-> 'sdlc' <-> 'deck'
  //
  // The row then looks indexed and the vector looks full while the match is false. Every check
  // that reads the vector's own shape agrees; the question is whether the text the latin half is
  // built from is the text the read path queries against.
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
  // The han half is still the analyzer's, asserted on the Chinese fixture above since the hyphen
  // fixture carries no Han. PostgreSQL's parser reads an unspaced Han run as one opaque token and
  // can produce none of these unigrams, so a row whose han half came from the raw text would be
  // unfindable.
  const han = bodyTsvParams(v);
  if (!String(han[3] ?? "").includes("迁") || !String(han[7] ?? "").includes("迁")) {
    return "the han half no longer carries the analyzer's unigrams, which PostgreSQL's parser cannot produce at all";
  }
  if (han[2] !== "迁移说明") return "the latin half is not the row's own title even when that title is Han";
});
