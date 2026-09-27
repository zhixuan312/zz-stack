import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bodyTsvParams, bodyTsvSql, buildRowVector, TEXT_SEARCH_CONFIG, termsByWeight } from "@zz/indexing";
import { root } from "../read.ts";
import { check } from "../run.ts";

// One construction (`bodyTsvSql`/`bodyTsvParams`) names both configurations in one place, and
// both the write and the read path read them from there. These checks assert that, not the SQL
// text two files happen to spell the same way today.
//
// The read path reads both halves: the Latin lane parses through `QUERY_CONFIG` and is probed
// through the predicate builder, and the Han lane's rank is scored through `SIMPLE_QUERY_CONFIG`
// and is probed through the handler's own scoring assembly. One check per half, because each half
// has a different way of going wrong: a stemmed query against an unstemmed word finds nothing at
// all, and a Han clause ranked through the Latin configuration finds every row it matched and
// ranks none of them.
//
// A stemmed query does not match an unstemmed stored word, even when they are the same word:
// `to_tsvector('simple','This migration replaces the old schema') @@
// websearch_to_tsquery('english','migration')` is false. Every English word whose stem differs
// from its surface form stops being findable, with no error and nothing in the row to see.

// The three files that write or read `zz.doc`/`zz.knowledge_node`'s `body_tsv`. This list is the
// scope of the agreement, and it is narrow on purpose — the read path is probed separately below.
const WRITE_FILES = [
  "packages/indexing/src/index.ts",
  "packages/indexing/src/rederivation.ts",
  "services/zz-core/src/tools/knowledge-search.ts",
];

check("no file names a text-search configuration except the one constant that defines them", () => {
  // A quoted literal as the first argument of any text-search call is a second place a
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
    return `the Han half is stored through ${TEXT_SEARCH_CONFIG.han}, but a ranking bigram is `
         + `written as an opaque term and only 'simple' leaves it alone — a ranking bigram `
         + `rewritten on its way in is unfindable and leaves no trace`;
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
        // This list decides the analyzer's field classification, not what is stored: the latin
        // half of `body_tsv` is the row's raw text. The read path spends that classification —
        // `buildSearchPredicate` routes a Han-bearing clause to a literal `body` match because
        // `websearch_to_tsquery` cannot see inside an unspaced Han run, so a Han scalar
        // classified `latin` is a clause sent down the lane that cannot match it.
        return `weight ${weight}'s latin terms carry ${term}, so the analyzer classified a Han `
             + `scalar as a Latin word — the read path routes that clause to the lane that `
             + `cannot see inside an unspaced Han run, and it matches nothing`;
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
  // Runs the builder against `dist` rather than reading its source: a service's own relative
  // imports carry the `.js` suffix NodeNext wants, which resolve only there. A probe that cannot
  // run is reported as that, never as a failure of the thing it was probing.
  const probe = `
    import { buildSearchPredicate } from ${JSON.stringify(join(root, "services/zz-core/dist/tools/search-predicate.js"))};
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

check("the read path scores a Han clause through the configuration the write path stored the Han half through, and binds every parameter the statement it builds names", () => {
  // The other half of the same decision, and the one the predicate above cannot show: a Han clause
  // is MATCHED as a literal `body` substring — which the trigram index serves — but it is RANKED
  // through the half of `body_tsv` the analyzer wrote its unigrams into. Scored through the Latin
  // configuration instead, it would rank nothing: `english` rewrites an opaque term on its way in,
  // so `ts_rank_cd` would return zero for every row the clause matched, with no error and nothing
  // in the row to see.
  //
  // Runs the handler's own scoring assembly rather than the predicate builder, because the rank
  // column is the handler's — `buildSearchPredicate` turns a query into a WHERE clause and has no
  // rank in it. That split is why this half needs a check of its own rather than one more case in
  // the probe above, and it is also where the second assertion comes from: the Han lane appends a
  // parameter to the predicate's, so the assembled statement has one more `$N` than the predicate
  // had and `query-arity.ts` counts neither — it reads whole statements and skips every assembled
  // one. A statement whose numbering skips is one PostgreSQL refuses to parse, so the lane would
  // answer nothing at all rather than answering wrong.
  const probe = `
    import { buildSearchPredicate } from ${JSON.stringify(join(root, "services/zz-core/dist/tools/search-predicate.js"))};
    import { scoringOf } from ${JSON.stringify(join(root, "services/zz-core/dist/tools/knowledge-search.js"))};
    const want = ${JSON.stringify(TEXT_SEARCH_CONFIG.han)};
    const bad = [];
    // A term, a longer unspaced run, an alternation with an ASCII operand, and each of them again
    // as the broadening retry. Only the Han-only ones are ranked here: an attempt carrying an
    // ASCII clause keeps the rank it has always had.
    const queries = ["\\u8fc1\\u79fb", "\\u8fc1\\u79fb\\u4f1a\\u7834\\u574f\\u65e7\\u7684\\u6a21\\u5f0f",
                     "\\u8fc1\\u79fb OR migration", "\\u8fc1\\u79fb -\\u6d4b\\u8bd5", "\\u8fc1\\u79fb migration"];
    for (const query of queries) {
      for (const broadened of [false, true]) {
        const attempt = buildSearchPredicate({ query, broadened });
        const scoring = scoringOf(attempt);
        const where = attempt.sql + (broadened ? " (broadened)" : "");
        // The statement as the handler assembles it, the predicate and the scoring columns
        // together — the one shape whose numbering PostgreSQL has to accept.
        const composed = "select id, " + scoring.sql + " from t where " + attempt.sql;
        const refs = [...new Set([...composed.matchAll(/\\$(\\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
        if (refs.length !== scoring.args.length || refs.some((n, i) => n !== i + 1)) {
          bad.push(where + ": binds " + scoring.args.length + " parameter(s) but the composed statement names $" +
                   (refs.join(", $") || "none") + " - PostgreSQL cannot parse a statement whose numbering skips one");
        }
        if (!attempt.hanTerms.length) { bad.push(where + " analysed into no Han terms at all"); continue; }
        // Every configuration the scoring names, whichever lane built it: the Han half's call for
        // the Han lane, the ASCII lane's websearch_to_tsquery call for the other.
        const configs = [...scoring.sql.matchAll(/tsquery\\(\\s*'([a-z_]+)'/g)].map((m) => m[1]);
        if (attempt.rankExpr) {
          // The control. An attempt carrying an ASCII clause keeps the rank it has always had, so
          // the Han half's configuration must not appear here — without this, a lane that was
          // never exercised would pass the assertion below by having nothing to fail it.
          if (configs.includes(want)) bad.push(where + " carries an ASCII clause and still ranked through the Han half");
          continue;
        }
        if (!configs.length) {
          bad.push(where + " built no rank for its Han terms, so every row it matches ties at zero");
          continue;
        }
        for (const got of configs) {
          if (got !== want) {
            bad.push(where + " ranks through '" + got + "' while the write path stored the Han half "
                     + "through '" + want + "'");
          }
        }
      }
    }
    console.log(JSON.stringify(bad));
  `;
  let out: string;
  try {
    out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", cwd: root });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    return `the Han read-path probe could not run, so this agreement is unchecked: ${String(e.stderr ?? e.message ?? err)}`;
  }
  const bad = JSON.parse(out.trim()) as string[];
  if (bad.length) return bad.join("; ");
});
