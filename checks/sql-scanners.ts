#!/usr/bin/env node
/**
 * The two statement readers in `packages/tools/src/lib` read code as code. `foldInterpolations`
 * finds the SQL a helper returns when the helper's parameter list destructures, and `queriesIn`
 * reports only a `.query(` in code — never one a comment or a string mentions — and hands back a
 * statement's escapes as the TypeScript literal means them.
 *
 * Pure: no database, no network. Reads the built `packages/tools/dist`.
 * Run: node checks/sql-scanners.ts
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Statements = typeof import("../packages/tools/src/lib/sql-statements.ts");
type Scan = typeof import("../packages/tools/src/lib/sql-scan.ts");
const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { foldInterpolations, regions }: Statements = await load("packages/tools/dist/lib/sql-statements.js");
const { queriesIn }: Scan = await load("packages/tools/dist/lib/sql-scan.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const fold = (helper: string): string => {
  const src = `${helper}\nconst q = \`select * from \${sel()}\`;\n`;
  return foldInterpolations("select * from ${sel()}", src, regions(src), "f.ts", () => null);
};
for (const params of ["(team)", "({ team })"]) {
  const folded = fold(`function sel${params} { if (team) { log(); } return "select a from zz.second"; }`);
  is(folded.includes("select a from zz.second"),
     `a helper declared sel${params} with a nested block folds to its statement, got ${JSON.stringify(folded)}`);
}

const src = [
  "// then p.query(sql) reads it",
  "const said = \"p.query(other)\";",
  "await p.query(\"select 1\\nfrom zz.team\");",
].join("\n");
const sites = queriesIn(src);
is(sites.length === 1, `only the call in code is a site, got ${JSON.stringify(sites)}`);
is(sites[0]?.line === 3 && sites[0]?.sql === "select 1\nfrom zz.team",
   `"\\n" in a statement arrives as a newline, got ${JSON.stringify(sites[0])}`);

if (fail.length) {
  for (const f of fail) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("sql-scanners: a destructured helper folds whole, and only a .query( in code is read, escapes intact: ok");
