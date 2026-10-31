#!/usr/bin/env node
/**
 * checks/search-broadened-rank.ts — `knowledge_search`'s broadened pass is ranked and excerpted
 * by the terms it relaxed.
 *
 *   node checks/search-broadened-rank.ts   # needs a built tree (`npm run build`)
 *
 * The broadened pass runs only when no document holds every word, and its answer says it is
 * "best first". Each relaxed term is its own `websearch_to_tsquery` in the predicate, so unless the
 * rank is built from them too the pool ties at zero and comes back newest first, its excerpts the
 * head of each text. Drives the built `buildSearchPredicate` and `scoringOf`, no database. What it
 * establishes, for unquoted terms alone, beside a quoted phrase, and beside an exclusion:
 *
 *   - the broadened attempt carries a rank expression, and `scoringOf` ranks by it;
 *   - the rank expression names only parameters the predicate already binds and references;
 *   - the excerpt text names every relaxed term, ORed, and keeps the phrase or exclusion.
 *
 * Exit 0: every case held. Exit 1: a case failed — what was found.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NAME = "search-broadened-rank";
const load = (p: string) => import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/tools", p)).href);
const { buildSearchPredicate } = await load("search-predicate.js");
const { scoringOf } = await load("knowledge-search.js");

interface Attempt { sql: string; args: unknown[]; rankExpr: string | null; asciiText: string | null; broadened: boolean }

const fail: string[] = [];
const cases: [string, string[], RegExp | null][] = [
  ["retry backoff deadline policy", ["retry", "backoff", "deadline", "policy"], null],
  ['"exponential backoff" retry deadline', ["retry", "deadline"], /"exponential backoff"/],
  ["retry deadline -legacy", ["retry", "deadline"], /-legacy/],
];
for (const [query, relaxed, kept] of cases) {
  const a = buildSearchPredicate({ query, team: "t", broadened: true }) as Attempt;
  if (!a.broadened) { fail.push(`${query}: the attempt did not broaden`); continue; }
  if (!a.rankExpr) { fail.push(`${query}: the broadened attempt has no rank expression, so its pool ties at zero`); continue; }
  const scoring = scoringOf(a) as { sql: string };
  if (/^0::float4/.test(scoring.sql)) fail.push(`${query}: scoringOf ranks the broadened pool by ${scoring.sql}`);
  const inWhere = new Set([...a.sql.matchAll(/\$(\d+)/g)].map((m) => m[1]));
  const stray = [...a.rankExpr.matchAll(/\$(\d+)/g)].map((m) => m[1]).filter((n) => !inWhere.has(n));
  if (stray.length) fail.push(`${query}: the rank names $${stray.join(", $")}, which the predicate does not reference`);
  const text = a.asciiText ?? "";
  if (relaxed.some((t) => !text.includes(t)) || !new RegExp(relaxed.join(" or ")).test(text) || (kept && !kept.test(text))) {
    fail.push(`${query}: the excerpt text is ${JSON.stringify(a.asciiText)}`);
  }
}

if (fail.length) {
  for (const f of fail) console.error(`${NAME}: ${f}`);
  process.exitCode = 1;
} else {
  console.log(`${NAME}: a broadened search is ranked and excerpted by the terms it relaxed: ok`);
}
