// AN INSERT NAMES AS MANY VALUES AS IT NAMES COLUMNS.
//
// `insert into t (a, b, c) values ($1, $2)` is a runtime error and nothing offline sees it:
// TypeScript does not read SQL in a template literal, and `check:sql` — which PREPAREs every
// statement and would catch it instantly — needs a migrated database, so it does not run in
// the gate and does not run on a laptop without one.
//
// This is not hypothetical. Removing the `blocks` column from zz.doc took the parameter out of
// the values ARRAY and left `$19::text[]` standing in the statement, so the insert named 19
// columns and 20 expressions. Every document write would have failed — and on the write path
// it fails inside a catch, so the service starts, the store keeps working, and only the index
// stops being written.
//
// COUNTED, NOT PARSED. This does not try to understand SQL: it finds `insert into <t> (...)`,
// counts the comma-separated names in the column list, then counts the top-level commas in the
// matching `values (...)`, which is the one property that can be checked without a database
// and the one that was wrong.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const fail: string[] = [];

/** Split on commas at paren-depth zero: a value slot may itself be a call, a cast or a
 *  `coalesce(...)` with commas inside it, and those are not separators. */
function topLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim()).filter(Boolean);
}

/** The balanced body of the parenthesis that starts at `from`. */
function balanced(src: string, from: number): { body: string; end: number } | null {
  const open = src.indexOf("(", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return { body: src.slice(open + 1, i), end: i };
  }
  return null;
}

function walk(dir: string): void {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith(".ts")) continue;
    // SQL comments removed first: a `--` line inside the statement carries commas and
    // parentheses of its own, and counting them is how a correct statement reads as broken.
    const src = readFileSync(p, "utf8").split("\n")
      .map((l) => (/^\s*--/.test(l) ? "" : l)).join("\n");
    for (const m of src.matchAll(/insert\s+into\s+([a-z_.]+)\s*\(/gi)) {
      const cols = balanced(src, m.index + m[0].length - 1);
      if (!cols) continue;
      // Only a literal VALUES list. `insert ... select` has no slots to count, and an
      // `insert ... values` built by a loop is not a literal either.
      const after = src.slice(cols.end + 1, cols.end + 40);
      if (!/^\s*values\s*\(/i.test(after)) continue;
      const vals = balanced(src, cols.end + 1);
      if (!vals) continue;
      const nCols = topLevel(cols.body).length;
      const nVals = topLevel(vals.body).length;
      if (nCols !== nVals) {
        const line = src.slice(0, m.index).split("\n").length;
        fail.push(
          `${p}:${line} — insert into ${m[1]} names ${nCols} column(s) and ${nVals} value(s). ` +
          "Postgres refuses the statement; on a write path that refusal lands inside a catch, " +
          "so the service starts and the index silently stops being written."
        );
      }
    }
  }
}

for (const dir of ["services", "packages", "scripts"]) walk(dir);

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("insert arity: ok");
