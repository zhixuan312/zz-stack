// A query binds as many parameters as its statement names.
//
// `pool.query(sql, [a, b])` against a statement whose highest placeholder is `$1` is rejected by
// the server: "bind message supplies 2 parameters, but prepared statement requires 1". Nothing
// offline sees it — TypeScript does not read SQL inside a template literal, and `check:sql`
// PREPAREs statements, where the prepare succeeds and the bind is what would fail.
//
// What this covers is the statements written out whole. A statement assembled from a `${...}`
// fragment has placeholders outside the literal and lands in the skipped count below; resolving
// those fragments (consts, ternaries, cross-module imports) or issuing a live BIND is
// `check:sql`'s territory and needs a migrated database.
//
// COUPLED: `insert-arity.ts` counts columns against values inside one statement. This counts the
// statement against its caller, which is the other half of the same class.
//
// Counted, not parsed. It finds a `.query(` whose first argument is a template literal and whose
// second is an array literal, takes the highest `$N` in the statement, and compares. Anything it
// cannot read cleanly — a variable holding the SQL, a spread, a computed array — is skipped
// rather than guessed at, and the skip count is printed so a rule that stops reaching anything
// says so instead of passing silently.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const fail: string[] = [];
let checked = 0, skipped = 0;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (e.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/** The matching close for the bracket opened at `from`, or -1 when it never closes. Quotes and
 *  template literals are skipped, because a paren inside a string is not structure. */
function matchBracket(s: string, from: number): number {
  const open = s[from], close = open === "(" ? ")" : "]";
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

for (const file of walk("services")) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\.query(?:<[^>]*>)?\(\s*`/g)) {
    const tickAt = src.indexOf("`", m.index!);
    // The statement: from the backtick to its unescaped close.
    let end = tickAt + 1;
    while (end < src.length && src[end] !== "`") { if (src[end] === "\\") end++; end++; }
    const sql = src.slice(tickAt + 1, end);
    // A statement carrying an interpolation may name placeholders this check cannot see —
    // ${RUNS_OF} holds its own $1 and $2 — so it is not readable here.
    if (sql.includes("${")) { skipped++; continue; }
    const after = src.slice(end + 1);
    const comma = after.match(/^\s*,\s*/);
    if (!comma) { skipped++; continue; }           // one-argument query: nothing to compare
    const arrAt = end + 1 + comma[0].length;
    if (src[arrAt] !== "[") { skipped++; continue; } // a variable, not a literal array
    const arrEnd = matchBracket(src, arrAt);
    if (arrEnd < 0) { skipped++; continue; }
    const inner = src.slice(arrAt + 1, arrEnd).trim();

    let supplied = 0;
    if (inner) {
      let depth = 0, n = 1;
      for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (c === "'" || c === '"' || c === "`") {
          const q = c; i++;
          while (i < inner.length && inner[i] !== q) { if (inner[i] === "\\") i++; i++; }
          continue;
        }
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (c === "," && depth === 0) n++;
      }
      // A spread makes the count unknowable from the source.
      if (inner.includes("...")) { skipped++; continue; }
      supplied = n;
    }

    const wanted = [...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
    const highest = wanted.length ? Math.max(...wanted) : 0;
    checked++;
    if (highest !== supplied) {
      const line = src.slice(0, tickAt).split("\n").length;
      fail.push(
        `${file}:${line} binds ${supplied} parameter(s) and the statement names ` +
        `${highest === 0 ? "none" : `$${highest}`} — postgres rejects the bind, and nothing ` +
        "else offline reads SQL inside a template literal");
    }
  }
}

// A rule that reaches nothing passes for the wrong reason, so the counts are printed and an
// empty walk is a failure.
if (!checked) {
  fail.push(`no readable .query(\`…\`, [...]) call was found under services/ — this check read ` +
            `nothing (${skipped} skipped)`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`query arity: ok — ${checked} statement(s) compared, ${skipped} not readable offline`);
