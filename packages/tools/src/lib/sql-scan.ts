/**
 * Find every `.query(...)` in a TypeScript source, with the statement it was handed, and every
 * `psqlRows(`, `psqlText(` and `psqlTry(` call (`./psql.ts`), with the statement that is its second
 * argument.
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

/** One call of a `psql.ts` reader. `via` is which: `psqlRows` runs its statement inside a
 *  `json_agg` of its own, and every one of them hands psql variables (`:'name'`) to psql to fill in. */
export interface PsqlSite extends QuerySite {
  via: "psqlRows" | "psqlText" | "psqlTry";
}

type Region = ReturnType<typeof regions>[number];

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

/** A literal's text as the TypeScript source means it: `\n`, `\t` and `\r` are the characters they
 *  name, and any other escaped character is itself. */
const unescaped = (text: string): string => text.replace(/\\([\s\S])/g, (_, c: string) => ESCAPES[c] ?? c);

/** The region holding `pos`. */
const regionIn = (rs: Region[], pos: number): number => rs.findIndex((r) => r.start <= pos && pos < r.end);

/** The statement that starts at `from`: past whitespace and comments to the first literal, and
 *  concatenated across `+`, or null when what comes first is not a literal. */
function statementAt(src: string, rs: Region[], from: number): string | null {
  let i = regionIn(rs, from);
  while (i >= 0 && i < rs.length && (rs[i].kind === "comment" ||
         (rs[i].kind === "code" && !src.slice(Math.max(from, rs[i].start), rs[i].end).trim()))) {
    i++;
  }
  if (i < 0 || i >= rs.length || rs[i].kind !== "literal") return null;
  // Concatenated across string literals: `"select ..." + " where ..."`. Taking only the first
  // half would PREPARE half a statement and report a syntax error this repository does not
  // have.
  let sql = unescaped(src.slice(rs[i].start + 1, rs[i].end - 1));
  while (rs[i + 1]?.kind === "code" && src.slice(rs[i + 1].start, rs[i + 1].end).trim() === "+" &&
         rs[i + 2]?.kind === "literal") {
    i += 2;
    sql += unescaped(src.slice(rs[i].start + 1, rs[i].end - 1));
  }
  return sql;
}

const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

/** Every `.query(...)` in `src`, in source order. */
export function queriesIn(src: string): QuerySite[] {
  const rs = regions(src);
  const out: QuerySite[] = [];
  // The match is on the whole source, because a type argument such as `.query<{ basis: "exact" }>(`
  // spans a literal.
  for (const m of src.matchAll(/\.query\s*(?:<[^>]*>)?\s*\(/g)) {
    const at = m.index ?? 0;
    if (rs[regionIn(rs, at)]?.kind !== "code") continue;
    const sql = statementAt(src, rs, at + m[0].length);
    out.push(sql === null
      ? { line: lineOf(src, at), sql: "", why: "the statement is a variable, not a literal here" }
      : { line: lineOf(src, at), sql });
  }
  return out;
}

/** Every call of `psqlRows`, `psqlText` or `psqlTry` in `src`, in source order: the statement is the
 *  argument after the first top-level comma. Their declarations are not calls. */
export function psqlCallsIn(src: string): PsqlSite[] {
  const rs = regions(src);
  const out: PsqlSite[] = [];
  for (const m of src.matchAll(/\b(psqlRows|psqlText|psqlTry)\s*(?:<[^>]*>)?\s*\(/g)) {
    const at = m.index ?? 0;
    if (rs[regionIn(rs, at)]?.kind !== "code" || /\bfunction\s*$/.test(src.slice(0, at))) continue;
    const via = m[1] as PsqlSite["via"];
    const line = lineOf(src, at);
    // The first argument is the psql command, which may itself be a call: the comma that ends it is
    // the first one in code at the call's own depth.
    let comma = -1;
    let depth = 0;
    const from = at + m[0].length;
    scan: for (let i = regionIn(rs, from); i >= 0 && i < rs.length; i++) {
      if (rs[i].kind !== "code") continue;
      for (let k = Math.max(from, rs[i].start); k < rs[i].end; k++) {
        const c = src[k];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") { if (depth-- === 0) break scan; }
        else if (c === "," && depth === 0) { comma = k; break scan; }
      }
    }
    const sql = comma < 0 ? null : statementAt(src, rs, comma + 1);
    out.push(sql === null
      ? { line, sql: "", why: "the statement is a variable, not a literal here", via }
      : { line, sql, via });
  }
  return out;
}
