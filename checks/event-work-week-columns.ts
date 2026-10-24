#!/usr/bin/env node
/**
 * checks/event-work-week-columns.ts — the week-grain read model holds a projection of `zz.event`
 * and nothing a rebuild from `zz.event` could not reproduce, and the register that decided what
 * reads the model was written before any reduction moved onto it.
 *
 *   node checks/event-work-week-columns.ts   # reads the schema target and ARCHITECTURE.md; no database
 *
 * `zz.event_work_week` is `class=projection; rebuilt_from=zz.event`. That is a promise a rebuild
 * script keeps by re-running one statement, so a column holding anything the statement cannot
 * derive is lost the first time somebody rebuilds — silently, because the row still reads. Two of
 * the numbers a reader wants are exactly that kind: whether a refusal was put right (`matched`)
 * and how many sessions continued (`continued_sessions`) are business state, decided elsewhere and
 * recorded nowhere in `zz.event`; a `last_call_at` per bucket is derivable but unbounded, and the
 * widest bucket's `ms` array is the field whose size already needs a projection. FR-16d says the
 * model carries none of it, and this is the file-level guard: the column arm fails the moment a
 * `matched`, `continued_sessions` or `last_call_at` column is added to the target.
 *
 * DELIBERATE: the column arm reads `schema-target/telemetry.ts`, not the migration. The target is
 * what a new host is built from and what every schema check diffs against; a column added there is
 * a column the next host has, whether or not the migration that added it was written carefully.
 * `checks/schema-inventory.ts` reads the same declaration for the same reason.
 *
 * The other three arms are AC-16.4's "before": the decision about which reads move onto the model
 * is taken once, in `ARCHITECTURE.md`, and a register written after the reductions moved is a
 * description of what happened rather than the decision a later reader can hold the change to. So
 * the four sections must exist by the headings the plan declares, the metric register must carry
 * its six metrics with every field filled in, and — because Task I-19's ten-times arm reads these
 * two numbers rather than hard-coding them — Usage's calls-by-week budget must be two numbers on a
 * line, not prose. A budget nobody could measure is not a budget, so `unmeasured` is refused there
 * rather than accepted as an escape; the `### What stays a raw query` section is where an
 * unmeasurable cost belongs, and no check parses it.
 *
 * Exit 0: every arm holds — one line.
 * Exit 1: the first arm that does not, quoting what it read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";
import { SCHEMA_TARGET } from "../schema-target.ts";

const TABLE = "event_work_week";
/** The three names this model must not carry, and why each is out of its reach — see the module doc. */
const NOT_HELD = [
  "matched",
  "continued_sessions",
  "last_call_at",
];

/** The four sections, in the order the plan writes them. */
const SECTIONS = [
  "The metric register",
  "The budget of each answer class",
  "Answer classes that miss on every event write",
  "What stays a raw query",
];

/** What the six metrics in the register are about. Each must appear somewhere in the register, so a
 *  register that names six of one kind — or fills its rows with the same metric twice — fails. */
const METRICS: Array<[string, RegExp]> = [
  ["calls by week and team", /week[\s\S]{0,80}team|team[\s\S]{0,80}week/i],
  ["calls by tool and week, with the median", /tool/i],
  ["calls by refusal owner", /refus|owner/i],
  ["refusals put right, `matched`", /`?matched`?/i],
  ["refusals put right, `continued_sessions`", /`?continued_sessions`?/i],
  ["calls by local weekday and hour", /hour|weekday/i],
];

/** One line, two numbers: `rows ≤ 1200, ms ≤ 40`. `≤` or `<=`, either spelling. */
const BUDGET = /rows\s*(?:≤|<=)\s*([\d,]+)\s*,\s*ms\s*(?:≤|<=)\s*([\d,]+)/i;

/** A `function`, not a `const` arrow: TypeScript narrows after a call only when the callee's own
 *  declaration says it never returns. */
function fail(step: string, detail: string): never {
  console.error(`event-work-week-columns: FAILED at "${step}": ${detail}`);
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

// 1 — the column arm. The model is a projection of `zz.event` and holds only what that rebuilds.
const table = SCHEMA_TARGET.tables[TABLE];
if (!table) fail("the read model is declared", `the schema target has no \`${TABLE}\` table`);
const columns = (table.columns ?? []).map((c) => String(c[0]));
for (const name of NOT_HELD) {
  if (columns.includes(name)) {
    fail("the read model holds no business state it cannot rebuild",
      `\`${TABLE}.${name}\` is declared in the schema target; \`zz.event_work_week\` is rebuilt from ` +
      `\`zz.event\` alone, so a rebuild would lose that column with no error`);
  }
}
pass(`the read model declares ${columns.length} column(s) and none of ${NOT_HELD.join(", ")}`);

// 2–4 — the register, written before the reductions move.
const md = readFileSync(join(root, "ARCHITECTURE.md"), "utf8");
const bodies = new Map<string, string>();
for (const heading of SECTIONS) {
  const body = sectionOf(md, heading);
  if (body === null) {
    fail("the four sections exist by the headings the plan declares",
      `ARCHITECTURE.md has no \`### ${heading}\` section`);
  }
  if (body.trim() === "") fail("the four sections exist by the headings the plan declares", `\`### ${heading}\` is empty`);
  bodies.set(heading, body);
}
pass(`ARCHITECTURE.md carries all four sections: ${SECTIONS.map((s) => `\`${s}\``).join(", ")}`);

const register = bodies.get(SECTIONS[0]) as string;
const rows = register.split("\n")
  .filter((l) => /^\s*\|/.test(l))
  .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
  .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)))     // the separator
  .filter((cells) => !cells.every((c) => c === ""));                  // a blank padding line
const data = rows.slice(1);                                           // minus the header
if (data.length !== 6) {
  fail("the register carries its six metrics",
    `\`### ${SECTIONS[0]}\` has ${data.length} data row(s), and the plan declares six: ` +
    `${METRICS.map(([what]) => what).join(", ")}`);
}
const width = Math.min(...data.map((cells) => cells.length));
if (width < 5) {
  fail("each metric row is filled in",
    `the narrowest row has ${width} cell(s); each metric needs its name, source, grain, what makes ` +
    `its answer change, and where it is served`);
}
data.forEach((cells, i) => {
  const empty = cells.map((c, j) => (c === "" ? j + 1 : 0)).filter((j) => j > 0);
  if (empty.length) {
    fail("each metric row is filled in", `row ${i + 1} (\`${cells[0]}\`) leaves cell(s) ${empty.join(", ")} empty`);
  }
});
const labels = data.map((cells) => cells[0].toLowerCase());
if (new Set(labels).size !== 6) {
  fail("the register carries its six metrics", `two rows name the same metric: ${labels.join(" / ")}`);
}
for (const [what, pattern] of METRICS) {
  if (!pattern.test(register)) fail("the register carries its six metrics", `nothing in it is about ${what}`);
}
pass(`the register carries six distinct metrics, every field filled in: ${data.map((c) => `\`${c[0]}\``).join(", ")}`);

const budget = bodies.get(SECTIONS[1]) as string;
if (/unmeasured/i.test(budget)) {
  fail("the Usage budget is two numbers",
    `\`### ${SECTIONS[1]}\` says "unmeasured" — a budget nobody could measure is not a budget, and ` +
    `an unmeasurable cost belongs in \`### ${SECTIONS[3]}\``);
}
if (!/calls?\s+by\s+week/i.test(budget)) {
  fail("the Usage budget is two numbers", `\`### ${SECTIONS[1]}\` does not name Usage's calls-by-week answer class`);
}
const m = budget.match(BUDGET);
if (!m) {
  fail("the Usage budget is two numbers",
    `no line in \`### ${SECTIONS[1]}\` reads \`rows ≤ N, ms ≤ M\` with two numbers — Task I-19's ` +
    `ten-times arm parses this line, so prose here leaves AC-16.1 without evidence`);
}
const [rowBudget, msBudget] = [m[1].replace(/,/g, ""), m[2].replace(/,/g, "")].map(Number);
if (!(rowBudget > 0) || !(msBudget > 0)) {
  fail("the Usage budget is two numbers", `the budget line parses to rows ${rowBudget}, ms ${msBudget}; both must be positive`);
}
pass(`Usage's calls-by-week budget is ${rowBudget} row(s) and ${msBudget} ms, read from \`ARCHITECTURE.md\``);
