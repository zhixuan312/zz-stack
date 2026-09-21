import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bodyTsvParams, bodyTsvSql, buildRowVector, TEXT_SEARCH_CONFIG, termsByWeight } from "@zz/indexing";
import { root } from "../read.ts";
import { check } from "../run.ts";

// THE DEFECT THIS EXISTS FOR. Task I-38's first form stored the whole of `body_tsv` through
// `to_tsvector('simple', …)`, because the analyzer's Han unigrams and `zh…` ranking bigrams
// must reach the index unaltered. The read path went on parsing its queries with the `english`
// configuration, which stems. A stemmed query does not match an unstemmed stored word — not
// even when they are the SAME word: measured on the pinned cluster,
// `to_tsvector('simple','This migration replaces the old schema') @@
// websearch_to_tsquery('english','migration')` is false. Every English word whose stem differs
// from its surface form silently stopped being findable, with no error and nothing in the row
// to see. Eleven checks passed over it because each tested one side.
//
// The repair is one construction (`bodyTsvSql`/`bodyTsvParams`) naming both configurations in
// one place, and both files reading them from there. These checks assert that, not the SQL
// text two files happen to spell the same way today.

// The four files that write or read `zz.doc`/`zz.knowledge_node`'s `body_tsv`. This list is
// the scope of the agreement, and it is narrow ON PURPOSE rather than by accident of whichever
// grep found it — see EXCLUDED below for the sites that name a configuration and are not part
// of it, and the assertion that keeps them that way.
const WRITE_FILES = [
  "packages/indexing/src/index.ts",
  "packages/indexing/src/rederivation.ts",
  "packages/indexing/src/tenant-rebuild.ts",
  "services/zz-core/src/tools/knowledge-search.ts",
];

// THE SITES DELIBERATELY OUTSIDE THIS AGREEMENT, pinned so the exclusion cannot quietly widen.
// `tenant-projections.ts` builds a GIN index over the NATIVE projections' `raw_body` — raw
// prose, a different column in a different lane, with no live reader and zero rows — and it is
// both written and read with the same configuration, so nothing there disagrees with anything.
// It carries the ORIGINAL Han defect (a prose tokenizer cannot segment an unspaced run), which
// is the native lane's own cutover work in Tasks I-20/I-21 and not this task's. If that
// expression were ever repointed at `body_tsv`, it would join this agreement, and the
// assertion below is what would notice.
const EXCLUDED: ReadonlyArray<readonly [string, string]> = [
  ["packages/indexing/src/tenant-projections.ts", "using gin (to_tsvector('english', raw_body))"],
];

check("the native-projection index is still the only text-search configuration outside the agreement", () => {
  for (const [rel, expected] of EXCLUDED) {
    const src = readFileSync(join(root, rel), "utf8");
    const named = [...src.matchAll(/\b(?:to_tsvector|to_tsquery|plainto_tsquery|phraseto_tsquery|websearch_to_tsquery|ts_headline|ts_rank|ts_rank_cd)\([^)]*'[a-z_]+'/g)];
    if (named.length !== 1) {
      return `${rel} now names a text-search configuration ${named.length} time(s), not the one `
           + `native-projection index this exclusion covers — a new site is either part of the `
           + `body_tsv agreement or a new exclusion somebody has to justify`;
    }
    if (!src.includes(expected)) {
      return `${rel}'s excluded site is no longer \`${expected}\` — if it now reads body_tsv it `
           + `must take its configuration from TEXT_SEARCH_CONFIG like every other reader of that column`;
    }
  }
});

check("no file names a text-search configuration except the one constant that defines them", () => {
  // A quoted literal as the FIRST argument of any text-search call is a second place a
  // configuration name can live, and therefore a place it can disagree with the other side.
  const literal = /\b(?:to_tsvector|to_tsquery|plainto_tsquery|phraseto_tsquery|websearch_to_tsquery|ts_headline|ts_rank|ts_rank_cd)\(\s*'/g;
  for (const rel of WRITE_FILES) {
    const src = readFileSync(join(root, rel), "utf8");
    const hits = src.match(literal) ?? [];
    if (hits.length) {
      return `${rel} spells a text-search configuration inline ${hits.length} time(s) (${hits.join(", ")}) — `
           + `it must read TEXT_SEARCH_CONFIG from @zz/indexing instead, because the write path and `
           + `the read path drifted apart for exactly one task the last time each named its own`;
    }
  }
});

check("the analyzer's opaque terms and its stemmable words are stored through different configurations", () => {
  if (TEXT_SEARCH_CONFIG.han !== "simple") {
    return `the Han half is stored through ${TEXT_SEARCH_CONFIG.han}, but testing/tenant-info/`
         + `analyzer-opacity.golden.json proves opacity for 'simple' and for nothing else — `
         + `a ranking bigram rewritten on its way in is unfindable and leaves no trace`;
  }
  const v = buildRowVector({
    title: "迁移说明 migration notes",
    tags: ["迁移", "schema"],
    body: "这个迁移会破坏旧的模式 and several decisions were revised",
  });
  const han = /\p{Script=Han}/u;
  const bigram = /^zh[0-9a-f]{12}$/;
  for (const weight of ["A", "B", "C"] as const) {
    for (const term of termsByWeight(v, weight, "latin").split(" ").filter(Boolean)) {
      if (han.test(term) || bigram.test(term)) {
        return `weight ${weight}'s latin half carries ${term}, which the backend would re-parse or `
             + `stem — an analyzer term the database rewrites cannot be queried back`;
      }
    }
    for (const term of termsByWeight(v, weight, "han").split(" ").filter(Boolean)) {
      if (!han.test(term) && !bigram.test(term)) {
        return `weight ${weight}'s han half carries ${term}, a Latin word — stored through `
             + `${TEXT_SEARCH_CONFIG.han} it is never stemmed, so the stemmed query the read `
             + `path sends can no longer match it`;
      }
    }
  }
  // The construction binds the configuration names; it never interpolates them into SQL text.
  const sql = bodyTsvSql(1);
  if (sql.includes(`'${TEXT_SEARCH_CONFIG.latin}'`) || sql.includes(`'${TEXT_SEARCH_CONFIG.han}'`)) {
    return "bodyTsvSql interpolates a configuration name into the statement instead of binding it";
  }
  const params = bodyTsvParams(v);
  if (params[0] !== TEXT_SEARCH_CONFIG.latin || params[1] !== TEXT_SEARCH_CONFIG.han) {
    return `bodyTsvParams binds ${params[0]}/${params[1]} where bodyTsvSql's $1/$2 are read as `
         + `regconfig, so each half of every row would be analysed by the wrong configuration`;
  }
  const used = new Set((sql.match(/\$\d+/g) ?? []));
  if (used.size !== params.length) {
    return `bodyTsvSql binds ${used.size} parameters and bodyTsvParams supplies ${params.length} — `
         + `a statement no caller can execute, and nothing here has ever executed one`;
  }
});

check("the read path queries with the configuration the write path stored a latin term through", () => {
  // RUNS the builder against `dist` rather than reading its source: a service's own relative
  // imports carry the `.js` suffix NodeNext wants, which resolve only there. A probe that
  // cannot run is reported as that, never as a failure of the thing it was probing.
  const probe = `
    import { buildSearchPredicate } from ${JSON.stringify(join(root, "services/zz-core/dist/tools/knowledge-search.js"))};
    const want = ${JSON.stringify(TEXT_SEARCH_CONFIG.latin)};
    const bad = [];
    const sqlOf = (args) => buildSearchPredicate(args).sql;
    const cases = [
      ["a plain ascii query", sqlOf({ query: "migration" })],
      ["a quoted ascii phrase", sqlOf({ query: '"old schema"' })],
      ["an ascii alternation", sqlOf({ query: "migration OR schema" })],
    ];
    for (const [what, sql] of cases) {
      const configs = [...sql.matchAll(/(?:websearch_to_tsquery|to_tsquery|ts_headline)\\(\\s*'([a-z_]+)'/g)].map((m) => m[1]);
      if (!configs.length) bad.push(what + " built no text-search query at all");
      for (const got of configs) {
        if (got !== want) bad.push(what + " parses with '" + got + "' while the write path stores a latin term through '" + want + "'");
      }
    }
    console.log(JSON.stringify(bad));
  `;
  let out: string;
  try {
    out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    return `the read-path probe could not run, so this agreement is unchecked: ${String(e.stderr ?? e.message ?? err)}`;
  }
  const bad = JSON.parse(out.trim()) as string[];
  if (bad.length) return bad.join("; ");
});
