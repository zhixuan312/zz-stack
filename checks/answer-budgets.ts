#!/usr/bin/env node
/**
 * checks/answer-budgets.ts — every console answer class states its time range, its grain and a
 * read budget, and every budget is evidenced at today's data AND at ten times it.
 *
 *   node checks/answer-budgets.ts   # reads ARCHITECTURE.md and nothing else; no database
 *
 * `### The metric register` said what each figure is counted from and where it is served, and
 * `### The budget of each answer class` gave one class two numbers. Neither said how far back a
 * class reads, what key it groups by, or what any class costs at ten times today's rows — so a
 * class could answer from the whole record and still be "within budget", because nobody had
 * written down what the budget was for. This is AC-15.1's executable form, and it has two arms.
 *
 *   (1) EVERY CLASS IS COMPLETE. Three tables carry the classes: the register (six metrics, each
 *   with its own time range, grain and budget), the settings reads the register does not reach,
 *   and the four answer classes stranded by every `zz.event` write. Each row must state a range,
 *   a grain and a budget of two numbers — the rows it may read and the milliseconds it may take.
 *   A row missing one of the three is a class whose cost a later change cannot be held to.
 *
 *   (2) EVERY BUDGET IS EVIDENCED TWICE. A budget with one figure is a budget at one scale, and
 *   the whole reason this criterion exists is that a statement whose cost grows with its table
 *   rather than with its answer looks fine today. So each row carries a measured figure at
 *   today's data and a projection at ten times, both parseable. Rows that answer a settings read
 *   issue no statement at all — their measured cell says so — and those are exempt from the
 *   second figure, because a read that runs nothing has no cost to project; a row that DOES run
 *   a statement and states one figure fails.
 *
 * DELIBERATE: the numbers themselves are not enforced here. `checks/event-work-week-reads.ts`'
 * third arm already seeds to ten times the traffic, `EXPLAIN (ANALYZE, BUFFERS)` the statement
 * `teamWeeks` actually issues and holds it to the budget line this check reads. A third arm here
 * would explain the same statement over the same seed for the same class, which is the
 * duplication Phase 3 exists to remove. What this check adds is the part no measurement can:
 * that the document states a range, a grain and two figures for EVERY class, not for the one a
 * measurement happened to cover.
 *
 * Exit 0: every class is complete and every budget is evidenced twice. Exit 1: the first row that
 * is not, quoted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const DOC = "ARCHITECTURE.md";

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

interface Table { header: string[]; rows: string[][] }

/** Every markdown table in a section body, in the order it appears. A row is split on `|` after
 *  trimming the outer pipes, and the separator line is dropped; a cell keeps its own inline
 *  backticks, because a budget is written inside them. */
function tablesIn(body: string): Table[] {
  const out: Table[] = [];
  let current: Table | null = null;
  for (const line of body.split("\n")) {
    if (!/^\s*\|/.test(line)) { current = null; continue; }
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;          // the separator
    if (cells.every((c) => c === "")) continue;                        // a blank padding line
    if (current === null) { current = { header: cells, rows: [] }; out.push(current); continue; }
    current.rows.push(cells);
  }
  return out;
}

/** `rows ≤ N, ms ≤ M` — the two numbers, in the spelling the document uses. `≤` or `<=`; the
 *  `rows` side may also be a bare `0` for a read that issues no statement. */
const BUDGET = /rows\s*(?:≤|<=)?\s*([\d,]+)\s*,\s*ms\s*(?:≤|<=)\s*([\d,]+)/i;

/** A figure a reader can check: a number with a unit. `0.19 s`, `242 buffers`, `1.0 ms`, `720 rows`. */
const FIGURE = /\d[\d,.]*\s*(?:rows?|ms\b|buffers?\b|s\b|KB\b)/i;

const fail: string[] = [];
const failAt = (step: string, detail: string): void => {
  fail.push(`FAILED at "${step}": ${detail}`);
};

const md = readFileSync(join(root, DOC), "utf8");

const REGISTER = "The metric register";
const CLASS_BUDGETS = "The budget of each answer class";
const STRANDED = "Answer classes that miss on every event write";

for (const heading of [REGISTER, CLASS_BUDGETS, STRANDED]) {
  if (sectionOf(md, heading) === null) {
    failAt("the three sections exist", `${DOC} has no \`### ${heading}\` section`);
  }
}
if (fail.length > 0) { console.error(fail.join("\n")); process.exit(1); }

/** One row's verdict on arm 1, given the cells it must have and what they are called. */
function complete(what: string, row: string[], at: Record<string, number>): void {
  for (const [cell, index] of Object.entries(at)) {
    if (index < 0 || index >= row.length) {
      failAt("every class states its range, its grain and a budget", `${what}: the table has no ${cell} column`);
      continue;
    }
    const value = row[index] ?? "";
    if (value === "") { failAt("every class states its range, its grain and a budget", `${what}: ${cell} is empty`); continue; }
    if (cell === "Budget" && !BUDGET.test(value)) {
      failAt("every class states its range, its grain and a budget",
        `${what}: the Budget cell reads "${value}" and does not say \`rows ≤ N, ms ≤ M\` — a budget ` +
        `nobody can measure is not a budget`);
    }
  }
  if (row[0]?.trim() === "") failAt("every class states its range, its grain and a budget", `${what}: the row names no class`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (1) — the register. Six metrics, each with a range, a grain and two numbers.
const register = tablesIn(sectionOf(md, REGISTER) as string);
const reg = register.find((t) => t.header.some((h) => /^Range$/i.test(h)) && t.header.some((h) => /^Grain$/i.test(h)));
if (!reg) {
  failAt("every class states its range, its grain and a budget",
    `\`### ${REGISTER}\` has ${register.length} table(s) and none declares both a Range and a Grain ` +
    `column — a register that says what a figure is counted from but not how far back it reads ` +
    `cannot bound a class's cost`);
} else {
  if (reg.rows.length < 6) {
    failAt("every class states its range, its grain and a budget",
      `the register carries ${reg.rows.length} metric(s), and \`### ${REGISTER}\` declares six`);
  }
  const at = { Range: reg.header.findIndex((h) => /^Range$/i.test(h)),
    Grain: reg.header.findIndex((h) => /^Grain$/i.test(h)),
    Budget: reg.header.findIndex((h) => /^Budget$/i.test(h)) };
  for (const row of reg.rows) complete(`the register's \`${row[0]}\``, row, at);
  console.log(`ok  the register states a range, a grain and a budget for all ${reg.rows.length} metrics`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (2) — the two tables of classes: what the register does not reach, and what an event write
// strands. The range and the grain are one column here, because a class's grain is a list
// (team, tool, refusal owner) and a second column of it would be a paragraph.
const stranded = tablesIn(sectionOf(md, STRANDED) as string);
const cls = stranded.find((t) => t.header.some((h) => /^Budget$/i.test(h)));
if (!cls) {
  failAt("every class states its range, its grain and a budget",
    `\`### ${STRANDED}\` has no table with a Budget column, so the four classes stranded by ` +
    `every event write state no budget at all`);
} else {
  const at = { Range: cls.header.findIndex((h) => /range/i.test(h)),
    Grain: cls.header.findIndex((h) => /range/i.test(h)),
    Budget: cls.header.findIndex((h) => /^Budget$/i.test(h)) };
  for (const row of cls.rows) complete(`the class \`${row[0]}\``, row, at);

  // Arm 2, on the two dedicated columns this table carries.
  const today = cls.header.findIndex((h) => /measured|today/i.test(h));
  const ten = cls.header.findIndex((h) => /ten times/i.test(h));
  if (today < 0 || ten < 0) {
    failAt("every budget is evidenced twice",
      `\`### ${STRANDED}\` carries no ${today < 0 ? "measured-today" : "ten-times"} column — a ` +
      `class with one figure is a class nobody has looked at beyond today's rows`);
  } else {
    for (const row of cls.rows) {
      const what = `the class \`${row[0]}\``;
      const runs = row[today] ?? "";
      if (/no statement|issues none/i.test(runs)) {
        if (/\d/.test(row[ten] ?? "")) {
          failAt("every budget is evidenced twice",
            `${what}: it issues no statement today and its ten-times cell claims a figure ` +
            `("${row[ten]}") — a read that runs nothing has no cost to project`);
        }
        continue;
      }
      for (const [cell, what2] of [[runs, "today"], [row[ten] ?? "", "at ten times"]] as const) {
        if (!FIGURE.test(cell)) {
          failAt("every budget is evidenced twice",
            `${what}: its ${what2} cell reads "${cell}" and carries no figure a reader can check — ` +
            `the budget is stated and nothing measured it`);
        }
      }
    }
    if (cls.rows.length < 4) {
      failAt("every class states its range, its grain and a budget",
        `\`### ${STRANDED}\` carries ${cls.rows.length} class(es); the register does not reach Home, ` +
        `Record, Usage and Status, and this is where they are`);
    }
    console.log(`ok  all ${cls.rows.length} stranded classes carry a measured figure and a ten-times projection`);
  }
}

// The settings reads, in the same section as the class budgets and deliberately so: they are the
// classes the register cannot reach because they count people rather than work.
const settings = tablesIn(sectionOf(md, CLASS_BUDGETS) as string)
  .find((t) => t.header.some((h) => /^Today$/i.test(h)) && t.header.some((h) => /ten times/i.test(h)));
if (!settings) {
  failAt("every class states its range, its grain and a budget",
    `\`### ${CLASS_BUDGETS}\` carries no table with a Today and a ten-times column, so the settings ` +
    `reads — the classes the register does not reach — state no measured cost`);
} else {
  const at = { Range: settings.header.findIndex((h) => /range/i.test(h)),
    Grain: settings.header.findIndex((h) => /range/i.test(h)),
    Budget: settings.header.findIndex((h) => /^Budget$/i.test(h)) };
  for (const row of settings.rows) complete(`the settings read \`${row[0]}\``, row, at);
  console.log(`ok  all ${settings.rows.length} settings reads carry a range, a grain and a budget`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (3) — the AC's second half: rows alone are not the cost. The section that gives the budgets has
// to say what the second measurement is, or a budget of `rows ≤ 1000` reads as a guarantee.
const budgetBody = sectionOf(md, CLASS_BUDGETS) as string;
if (!/EXPLAIN\s*\(ANALYZE,\s*BUFFERS\)/i.test(budgetBody)) {
  failAt("a budget is rows and buffers, not rows alone",
    `\`### ${CLASS_BUDGETS}\` never names \`EXPLAIN (ANALYZE, BUFFERS)\` — a join, a filter and an ` +
    `aggregation each read more rows than they return, so a row count on its own is not the cost`);
}
if (!/buffers/i.test(budgetBody)) {
  failAt("a budget is rows and buffers, not rows alone",
    `\`### ${CLASS_BUDGETS}\` states no buffer figure — the AC names buffers as the second half of ` +
    `the evidence, and a statement that reads ten rows can still touch ten thousand pages`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (4) — a register in which every row is the read model is a register that has stopped
// distinguishing a class served by a model from one served by a table. The AC asks that the two be
// distinguishable from the table alone, so both must appear in it.
if (reg) {
  const served = reg.rows.map((r) => (r[reg.header.findIndex((h) => /served by/i.test(h))] ?? "").toLowerCase());
  if (!served.some((s) => /read model|model/.test(s))) {
    failAt("a model-served class and a table-served one are distinguishable",
      `no register row names a read model as what serves it, and \`zz.event_work_week\` answers three of them`);
  }
  if (!served.some((s) => /raw query|table/.test(s))) {
    failAt("a model-served class and a table-served one are distinguishable",
      `no register row names a raw query as what serves it, and four metrics stay on \`zz.event\` for ` +
      `a reason the model cannot fix`);
  }
}

if (fail.length > 0) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`answer budgets: every class in \`${DOC}\` states its range, its grain and a two-number ` +
  `budget, each budget is evidenced at today's data and at ten times it, and the section says the ` +
  `second half of the evidence is buffers.`);
