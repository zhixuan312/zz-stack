/**
 * Find every `.query(...)` in a TypeScript source, with the statement it was handed.
 *
 * Used twice: `check:sql` PREPAREs these against a live schema before a release, and the gate's
 * console check (`scripts/gate/checks/console.ts`) holds the console routes to passing only
 * literals, offline, so a query assembled at request time cannot slip past the first check by not
 * being one statement. Both read call sites through here, so they agree on where a statement starts
 * and ends.
 *
 * Read through `regions()`, the split `sql-statements.ts` makes of a source: a `.query(` that a
 * comment or a string mentions is not a call, and the statement is the first literal after the open
 * paren, past whitespace and comments, because the SQL here is routinely preceded by a paragraph
 * explaining it.
 */
import { regions } from "./sql-statements.js";

/** One `.query()` call site. `sql` is empty when the statement could not be read as a literal;
 * `why` then says which of the two reasons it was. */
export interface QuerySite {
  line: number;
  sql: string;
  /** Set when this call site carries no single readable statement. */
  why?: string;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

/** A literal's text as the TypeScript source means it: `\n`, `\t` and `\r` are the characters they
 *  name, and any other escaped character is itself. */
const unescaped = (text: string): string => text.replace(/\\([\s\S])/g, (_, c: string) => ESCAPES[c] ?? c);

/** Every `.query(...)` in `src`, in source order. */
export function queriesIn(src: string): QuerySite[] {
  const rs = regions(src);
  /** The region holding `pos`. The match is on the whole source, because a type argument such as
   *  `.query<{ basis: "exact" }>(` spans a literal. */
  const regionAt = (pos: number): number => rs.findIndex((r) => r.start <= pos && pos < r.end);
  const out: QuerySite[] = [];
  for (const m of src.matchAll(/\.query\s*(?:<[^>]*>)?\s*\(/g)) {
    const at = m.index ?? 0;
    if (rs[regionAt(at)]?.kind !== "code") continue;
    const line = src.slice(0, at).split("\n").length;
    // Past whitespace and comments to the first region that says something.
    const from = at + m[0].length;
    let i = regionAt(from);
    while (i >= 0 && i < rs.length && (rs[i].kind === "comment" ||
           (rs[i].kind === "code" && !src.slice(Math.max(from, rs[i].start), rs[i].end).trim()))) {
      i++;
    }
    if (i < 0 || i >= rs.length || rs[i].kind !== "literal") {
      out.push({ line, sql: "", why: "the statement is a variable, not a literal here" });
      continue;
    }
    // Concatenated across string literals: `"select ..." + " where ..."`. Taking only the first
    // half would PREPARE half a statement and report a syntax error this repository does not
    // have.
    let sql = unescaped(src.slice(rs[i].start + 1, rs[i].end - 1));
    while (rs[i + 1]?.kind === "code" && src.slice(rs[i + 1].start, rs[i + 1].end).trim() === "+" &&
           rs[i + 2]?.kind === "literal") {
      i += 2;
      sql += unescaped(src.slice(rs[i].start + 1, rs[i].end - 1));
    }
    out.push({ line, sql });
  }
  return out;
}
