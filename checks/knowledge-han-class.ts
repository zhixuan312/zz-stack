#!/usr/bin/env node
/**
 * checks/knowledge-han-class.ts — the scope probe of an empty `knowledge_search` and the clause
 * split agree on what Han is: `HAN_SQL_CLASS`, the PostgreSQL character class the probe binds,
 * matches exactly the scalar values `HAN_SCALAR_RE` matches. Pure: nothing but the built
 * `search-predicate.js`.
 *
 *   node checks/knowledge-han-class.ts   # needs a built tree (`npm run build`)
 *
 * The class is read as a JavaScript regex, whose bracket ranges of literal characters mean what
 * PostgreSQL's do. It once covered U+4E00..U+9FFF alone, so a body written in Extension A or a
 * supplementary plane was reported as holding no Han while the query was split as Han (second
 * read, rs14-2).
 *
 * Exit 0: every scalar value agreed. Exit 1: the first values that did not, each with both answers.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const P = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/tools/search-predicate.js")).href) as {
  HAN_SCALAR_RE: RegExp; HAN_SQL_CLASS: string;
};

const asClass = new RegExp(`^${P.HAN_SQL_CLASS}$`, "u");
const wrong: string[] = [];
let han = 0;
for (let cp = 0; cp < 0x110000 && wrong.length < 10; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  const scalar = P.HAN_SCALAR_RE.test(ch);
  if (scalar) han += 1;
  if (asClass.test(ch) !== scalar) wrong.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}: HAN_SCALAR_RE ${scalar}, HAN_SQL_CLASS ${!scalar}`);
}
// Extension A and Extension B, named: the two a BMP-only range misses first.
for (const cp of [0x3400, 0x20000]) {
  if (!asClass.test(String.fromCodePoint(cp))) wrong.push(`U+${cp.toString(16).toUpperCase()} is not in HAN_SQL_CLASS`);
}

if (wrong.length || han === 0) {
  console.error(`knowledge-han-class: ${han === 0 ? "HAN_SCALAR_RE matched nothing; " : ""}${wrong.join("; ")}`);
  process.exit(1);
}
console.log(`knowledge-han-class: HAN_SQL_CLASS matches exactly the ${han} scalar values HAN_SCALAR_RE does: ok`);
