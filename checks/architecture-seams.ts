#!/usr/bin/env node
/**
 * checks/architecture-seams.ts — the seam between a page and the tables: which read models exist
 * and why each one does, what a page may cost, and the two shapes §5 refuses by name.
 *
 *   node checks/architecture-seams.ts   # reads ARCHITECTURE.md and the schema target; no database
 *
 * AC-8.1 is a decision a person owns — the spec's verification table says so in as many words —
 * and the only thing a check can hold is that the decision is still written and still says what
 * it decided. Three ways §5 loses that without anyone deleting a paragraph:
 *
 *   A read model named in prose and gone from `schema-target/`, or declared without a
 *   `rebuilt_from=`. `rebuilt_from` is the promise a rebuild keeps: a model whose source is
 *   unstated is one nobody can repair, and the row still reads either way.
 *
 *   A refusal that decays from four mechanisms into a preference. "We use a projection instead of
 *   a materialized view" reads like taste, and taste is undone by the next person who finds
 *   `REFRESH` shorter to declare. The four reasons are mechanisms — a lock, a full recompute, a
 *   statistics gap, and an object the schema gate cannot see — so this arm asks for each one by
 *   name rather than counting sentences.
 *
 *   A whole-history statement with one figure. `### What stays a raw query` is the list of reads
 *   that grow with `zz.event`, and a row carrying only today's cost says nothing about whether the
 *   statement is a problem at ten times the traffic — which is the only question the list exists
 *   to answer.
 *
 * DELIBERATE: the read-model arm reads the list §5 keeps in its own table, and not every
 * `zz.<table>` the section mentions. The section has to name `zz.event` — it is the source every
 * model is rebuilt from, and the paragraph that says so is the one that makes the model
 * trustworthy — so an arm that judged every mention would redden on the section it asked for.
 *
 * DELIBERATE: the autovacuum arm is negative as well as positive. The refusal of a materialized
 * view has been made elsewhere on a claim that autovacuum ignores them, and that claim is false:
 * PostgreSQL's autovacuum does consider `RELKIND_MATVIEW` and will analyze one on its own
 * schedule. A document that keeps the false claim is worse than one that never mentioned
 * vacuuming, because it teaches the next reader the wrong thing about the table they are
 * avoiding, so the arm fails on the claim's presence and not only on its absence from a list.
 *
 * Exit 0: every arm holds — one line each.
 * Exit 1: the first arm that does not, quoting what it read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SCHEMA_TARGET } from "../schema-target.ts";
import { root } from "../scripts/deployment.ts";

/** The three subsections AC-8.1 adds to §5, by the headings the plan declares. */
const SECTIONS = [
  "Which read models exist, and why each one does",
  "What a page may cost",
  "The two shapes this refuses",
];

/** The list of statements that stay whole-history. Its rows carry two figures each. */
const RAW_QUERIES = "What stays a raw query";

/** One figure: a number and the unit it is a number of, as the prose records every cost here. */
const FIGURE = /(\d[\d,]*(?:\.\d+)?)\s*(µs|us|ms|s)\b/;

/** Two mechanisms must be stated near each other to count as one reason. A section with "the
 *  whole history" in one paragraph and "refresh" in another has not said why a refresh costs
 *  what it costs, so proximity is what the arm asks for rather than mere presence. */
const NEAR = 300;

/** A `function`, not a `const` arrow: TypeScript narrows after a call only when the callee's own
 *  declaration says it never returns. */
function fail(step: string, detail: string): never {
  console.error(`architecture-seams: FAILED at "${step}": ${detail}`);
  process.exit(1);
}
const pass = (line: string): void => console.log(`ok ${line}`);

/** The body of `### <heading>`, down to the next heading of any level. */
function sectionOf(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && l.replace(/^#{2,4}\s+/, "").trim() === heading);
  if (start < 0) return null;
  const level = (lines[start].match(/^#+/) ?? [""])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Each table in a section, as rows of trimmed cells with the header first. A row of dashes is
 *  the markdown separator and is dropped; anything else that starts with a pipe is content. */
function tablesIn(body: string): string[][][] {
  const out: string[][][] = [];
  let current: string[][] | null = null;
  for (const line of body.split("\n")) {
    if (!/^\s*\|/.test(line)) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    (current ??= []).push(cells);
  }
  if (current) out.push(current);
  return out;
}

/** Whether `second` is stated within `window` characters of some `first`. The whole section is
 *  searched because a paragraph of prose is not a record: the reasons may be one sentence or four
 *  bullets, and both are a mechanism stated once. */
function within(text: string, first: RegExp, second: RegExp, window = NEAR): boolean {
  for (const m of text.matchAll(new RegExp(first.source, "gi"))) {
    const at = m.index ?? 0;
    if (second.test(text.slice(Math.max(0, at - window), at + window))) return true;
  }
  return false;
}

const md = readFileSync(join(root, "ARCHITECTURE.md"), "utf8");

// 1 — the decision is on the page.
const bodies = new Map<string, string>();
for (const heading of SECTIONS) {
  const body = sectionOf(md, heading);
  if (body === null) {
    fail("the seam decision carries its three subsections",
      `ARCHITECTURE.md has no \`### ${heading}\` — AC-8.1 is written in §5, and a heading's absence ` +
      "is the decision going unwritten rather than moving somewhere else");
  }
  if (body.trim() === "") fail("the seam decision carries its three subsections", `\`### ${heading}\` is empty`);
  bodies.set(heading, body);
}
pass(`ARCHITECTURE.md carries the three subsections: ${SECTIONS.map((s) => `\`${s}\``).join(", ")}`);

// 2 — every read model on the section's own list is a declared projection with a source.
const list = tablesIn(bodies.get(SECTIONS[0]) as string)[0];
if (!list || list.length < 2) {
  fail("every read model the section names exists",
    `\`### ${SECTIONS[0]}\` keeps no table holding a read-model row, so this arm would pass by ` +
    "finding nothing");
}
const named = list.slice(1).map((cells) => {
  const cell = cells[0] ?? "";
  const name = cell.replace(/`/g, "").trim();
  if (!/^zz\.[a-z_]+$/.test(name)) {
    fail("every read model the section names exists",
      `a row of that list reads \`${cell}\` in its first cell, which is not a \`zz.<table>\` name — ` +
      "the arm cannot tell which model the row is about");
  }
  return name.slice("zz.".length);
});
for (const name of named) {
  const table = SCHEMA_TARGET.tables[name];
  if (!table) {
    fail("every read model the section names exists",
      `\`zz.${name}\` is listed as a read model and \`schema-target/\` declares no such table — ` +
      "the prose outlived its declaration");
  }
  const comment = table.comment ?? "";
  if (!/\bclass=projection\b/.test(comment)) {
    fail("every read model the section names exists",
      `\`zz.${name}\` is listed as a read model and its target comment does not carry ` +
      `\`class=projection\`; it reads: ${comment.slice(0, 120)}`);
  }
  if (!/;\s*rebuilt_from=\S/.test(comment)) {
    fail("every read model the section names exists",
      `\`zz.${name}\` is declared without a \`rebuilt_from=\`, so a rebuild has no statement to ` +
      "re-run and nothing says what the model is a projection of");
  }
}
pass(`every read model on that list is a declared projection with a source: ${named.map((n) => `\`zz.${n}\``).join(", ")}`);

// 3 — the two refusals are mechanisms, not adjectives.
const refusals = (bodies.get(SECTIONS[2]) as string).replace(/\s+/g, " ");
if (!/a saved query and saves no work/.test(refusals)) {
  fail("a plain view is refused by what it does not save",
    `\`### ${SECTIONS[2]}\` does not say a view is "a saved query and saves no work" — without ` +
    "that, refusing a view is a preference and the next reader may take the shorter route");
}
const REASONS: Array<[string, boolean]> = [
  ["the ACCESS EXCLUSIVE lock, and CONCURRENTLY as the way round it",
    /ACCESS EXCLUSIVE/i.test(refusals) && /CONCURRENTLY/i.test(refusals)],
  ["the whole history recomputed on every refresh", within(refusals, /whole history/i, /refresh/i)],
  ["the statistics a refresh leaves stale until ANALYZE", within(refusals, /statistic/i, /\bANALYZE\b/i)],
  ["`schema-target.ts` seeing only `tables`", within(refusals, /schema-target\.ts/, /tables/i)],
];
const missing = REASONS.filter(([, held]) => !held).map(([what]) => what);
if (missing.length > 0) {
  fail("a materialized view is refused by four mechanisms and not by an adjective",
    `\`### ${SECTIONS[2]}\` is missing ${missing.length === REASONS.length ? "all four" : `${missing.length} of four`}: ` +
    `${missing.join("; ")}`);
}
if (/autovacuum\s+(?:ignores|skips|never\s+(?:touches|considers|analy[sz]es))/i.test(refusals)) {
  fail("the refusal does not rest on a false claim about autovacuum",
    `\`### ${SECTIONS[2]}\` says autovacuum passes a materialized view by. It does not: PostgreSQL's ` +
    "autovacuum considers `RELKIND_MATVIEW` and analyzes one on its own schedule, so a refusal " +
    "resting on that claim is refused here instead");
}
if (!within(refusals, /autovacuum/i, /RELKIND_MATVIEW/, 400)) {
  fail("the refusal states what autovacuum does with a materialized view",
    `\`### ${SECTIONS[2]}\` refuses a materialized view without saying that autovacuum does ` +
    "consider `RELKIND_MATVIEW` — leaving the false claim available to the next reader");
}
if (!within(refusals, /RELKIND_MATVIEW/, /false/i, 400)) {
  fail("the refusal states that the autovacuum claim is false",
    `\`### ${SECTIONS[2]}\` names \`RELKIND_MATVIEW\` without saying the claim that autovacuum ` +
    "ignores one is false; the spec's AC-8.1 requires the claim denied, not merely omitted");
}
pass(`a view and a materialized view are refused by name: ${REASONS.length} mechanisms, and the ` +
     "autovacuum claim denied rather than repeated");

// 4 — every whole-history statement carries a cost today and a projection at ten times.
const raw = sectionOf(md, RAW_QUERIES);
if (raw === null) fail("every whole-history statement carries both of its costs",
  `ARCHITECTURE.md has no \`### ${RAW_QUERIES}\``);
const costs = tablesIn(raw).find((t) =>
  t[0] !== undefined && t[0].some((c) => /^today$/i.test(c)) && t[0].some((c) => /ten times|10\s*×/i.test(c)));
if (!costs) {
  fail("every whole-history statement carries both of its costs",
    `\`### ${RAW_QUERIES}\` has no table with a \`Today\` column and an \`At ten times\` column — ` +
    "one figure is a measurement, and two are the decision");
}
const header = costs[0] as string[];
const today = header.findIndex((c) => /^today$/i.test(c));
const ten = header.findIndex((c) => /ten times|10\s*×/i.test(c));
const rows = costs.slice(1);
if (rows.length === 0) fail("every whole-history statement carries both of its costs",
  `that table has a header and no statement beneath it`);
for (const cells of rows) {
  const name = (cells[0] ?? "a row").replace(/`/g, "");
  const one = cells[today] ?? "";
  const many = cells[ten] ?? "";
  if (!FIGURE.test(one)) {
    fail("every whole-history statement carries both of its costs",
      `\`${name}\` has no measured cost today — its \`Today\` cell reads \`${one}\`, and a figure ` +
      "here is a number followed by a unit");
  }
  if (!FIGURE.test(many)) {
    fail("every whole-history statement carries both of its costs",
      `\`${name}\` has no projection at ten times — its \`At ten times\` cell reads \`${many}\`, and ` +
      "a row with one figure cannot say whether the statement is a problem at ten times the traffic");
  }
}
pass(`${rows.length} whole-history statement(s) each carry a cost today and a projection at ten times`);
