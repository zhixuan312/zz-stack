/**
 * Find every `.query(...)` in a TypeScript source, with the statement it was handed.
 *
 * ONE SCANNER, USED TWICE. `check:sql` PREPAREs these against a live schema before a release;
 * `scripts/gate.mjs` holds console.ts to passing only literals, offline, so that a query
 * assembled at request time cannot slip past the first check by not being one statement at
 * all. Both need to agree, exactly, on where a statement starts and ends.
 *
 * They used to be two copies. The gate's said so in its own comment — "mirrors sql-check.ts's
 * own scan … because a second, differently-written scanner is how the two quietly disagree
 * about what counts" — which is the argument for sharing one, not for keeping two in step by
 * hand. This is that one.
 *
 * Reads forward from the open paren past whitespace and comments, because the SQL in this
 * repository is routinely preceded by a paragraph explaining it — that is the house style, and
 * skipping those comments is the difference between finding 74 queries and finding 40.
 */

/** One `.query()` call site. `sql` is empty when the statement could not be read as a literal;
 * `why` then says which of the two reasons it was. */
export interface QuerySite {
  line: number;
  sql: string;
  /** Set when this call site carries no single readable statement. */
  why?: string;
}

/** Every `.query(...)` in `src`, in source order. */
export function queriesIn(src: string): QuerySite[] {
  const out: QuerySite[] = [];
  for (const m of src.matchAll(/\.query\s*(?:<[^>]*>)?\s*\(/g)) {
    let i = (m.index ?? 0) + m[0].length;
    // Past whitespace, line comments and block comments, to the first real character.
    for (;;) {
      const c = src[i];
      if (c === undefined) break;
      if (/\s/.test(c)) { i++; continue; }
      if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i) + 1; continue; }
      if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 2; continue; }
      break;
    }
    const line = src.slice(0, m.index).split("\n").length;
    const quote = src[i];
    if (quote !== "`" && quote !== '"' && quote !== "'") {
      out.push({ line, sql: "", why: "the statement is a variable, not a literal here" });
      continue;
    }
    let j = i + 1, sql = "";
    while (j < src.length && src[j] !== quote) {
      if (src[j] === "\\") { sql += src[j + 1]; j += 2; continue; }
      sql += src[j]; j++;
    }
    // Concatenated across string literals: `"select ..." + " where ..."`. Taking only the
    // first half would PREPARE half a statement and report a syntax error this repository
    // does not have — the worst kind of finding, because it is loud and wrong.
    if (/^\s*\+/.test(src.slice(j + 1, j + 40))) {
      let k = j + 1;
      for (;;) {
        const plus = /^\s*\+\s*/.exec(src.slice(k));
        if (!plus) break;
        k += plus[0].length;
        const q2 = src[k];
        if (q2 !== "`" && q2 !== '"' && q2 !== "'") break;
        let n = k + 1;
        while (n < src.length && src[n] !== q2) {
          if (src[n] === "\\") { sql += src[n + 1]; n += 2; continue; }
          sql += src[n]; n++;
        }
        k = n + 1;
      }
    }
    out.push({ line, sql });
  }
  return out;
}
