/**
 * Find every `.query(...)` in a TypeScript source, with the statement it was handed.
 *
 * One scanner, used twice: `check:sql` PREPAREs these against a live schema before a release,
 * and the gate's console check (`scripts/gate/checks/console.ts`) holds the console routes to
 * passing only literals, offline, so a query assembled at request time cannot slip past the
 * first check by not being one statement. Both must agree
 * exactly on where a statement starts and ends.
 *
 * Reads forward from the open paren past whitespace and comments, because the SQL here is
 * routinely preceded by a paragraph explaining it, and a scanner that stopped at the comment
 * would miss the statement.
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
    // Concatenated across string literals: `"select ..." + " where ..."`. Taking only the first
    // half would PREPARE half a statement and report a syntax error this repository does not
    // have.
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
