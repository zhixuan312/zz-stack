/**
 * The tool report ACROSS RUNS: every saved report as one row per refusal class, and what
 * moved between two of them.
 *
 * SPLIT OUT OF tool-report.ts BY SUBJECT, the way the chain check is split. That file answers
 * "what did the tool surface do in this window" from the platform database; these two answer
 * "is it getting better", which is a question about a DIRECTORY OF SAVED REPORTS and touches
 * no database at all. One reads the present, the other reads the history, and they share only
 * the shape a saved report has.
 *
 * Why a class and not a rate: the accepted RATE is the number everyone reaches for and the one
 * that lies, because it is governed by which tools a run happened to call. One measured run
 * was 93.8% accepted with seven of its eight failures on a single tool — call that tool twice
 * instead of nine times and the rate jumps four points while nothing has been fixed. A refusal
 * CLASS does not move like that: it is present or it is not, and when it stops appearing
 * something was closed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { die } from "../lib/cli.js";
import { localStamp } from "../lib/shell.js";
import { isReport, type ReportShape } from "./tool-report.js";

/** Every saved run, as one row per refusal class.
 *
 * That is what a loop has to show to have earned its cost: not a curve that drifts up, but a
 * row that reaches zero and stays there. A row that never reaches zero across runs is not
 * noise either — it is a defect nobody has taken, which is worth seeing precisely because it
 * is easy to stop noticing. */
export function showLedger(directory: string): void {
  const files = readdirSync(directory).filter((f) => f.endsWith(".json")).map((f) => join(directory, f));
  if (files.length === 0) die(`no saved reports in ${directory} — write some with --json first`);

  // PARSED ONCE, AND WHAT WILL NOT PARSE IS NAMED. `taken()` below tolerated a file that is
  // not a report — "fall through to the file's own timestamp" — and the very next expression
  // parsed every file again with no such tolerance, so the tolerance was decorative: a stray
  // `notes.json` beside the saved runs ended --ledger on a raw SyntaxError, which is exactly
  // what lib/cli.ts exists to stop an operator seeing.
  //
  // Dropped files are COUNTED and listed rather than skipped quietly. This tool's own ledger
  // is a claim about runs over time, and one that silently leaves runs out is the shape
  // flow-compare names: a silently dropped denominator is how a comparison lies.
  const parsed: { name: string; report: ReportShape; taken: string }[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      skipped.push(`${basename(f)} (not JSON)`);
      continue;
    }
    if (!isReport(report)) {
      skipped.push(`${basename(f)} (JSON, but not a report — no calls/refusals)`);
      continue;
    }
    // Ordered by WHEN each report was taken, not by filename. Sorting by name put a report
    // generated at 21:47 before a hand-named baseline from that morning, so the earlier run's
    // refusal classes — the ones that had in fact CLOSED — were labelled NEW. A ledger that
    // can print an improvement as a regression is worse than no ledger, and the only reason
    // it did was that one of the two files had been named by a person.
    parsed.push({ name: basename(f, ".json"), report, taken: report.generated || localStamp(statSync(f).mtime) });
  }
  if (skipped.length) console.log(`  not read: ${skipped.join(", ")}`);
  if (parsed.length === 0) {
    die(`no readable reports in ${directory} — ${files.length} .json file(s) there, none of ` +
        "them written by --json or --save");
  }
  const loaded = parsed
    .sort((a, b) => a.taken.localeCompare(b.taken))
    .map((x) => [x.name, x.report] as const);

  // One run is a baseline, not a trend, and every class in it would otherwise be marked NEW —
  // which reads as "these just appeared" when it only means "nothing preceded this".
  const solo = loaded.length === 1;
  console.log(
    `\n${loaded.length} run${solo ? "" : "s"} in ${directory}` +
      (solo ? "  — a baseline. Improvement is what the NEXT run does to these rows." : "") +
      "\n",
  );
  const width = Math.max(...loaded.map(([n]) => n.length)) + 2;
  console.log("  " + loaded.map(([n]) => n.padEnd(width)).join(""));
  console.log("  " + loaded.map(([, r]) => `${r.calls} calls`.padEnd(width)).join(""));
  console.log("  " + loaded.map(([, r]) => `${r.accepted_rate}% ok`.padEnd(width)).join(""));
  console.log();

  const classes = new Map<string, number[]>();
  loaded.forEach(([, r], i) => {
    for (const entry of r.refusals ?? []) {
      if (!classes.has(entry.class)) classes.set(entry.class, new Array<number>(loaded.length).fill(0));
      classes.get(entry.class)![i] = entry.count;
    }
  });

  if (classes.size === 0) {
    console.log("  no refusals in any run");
    return;
  }

  // Closed last, open first: what is still costing you belongs at the top.
  //
  // The first key was `counts[last] ? 1 : 0` and the sort is ascending, so a class that had
  // reached zero sorted ABOVE one still costing you every run — the exact inversion of the
  // sentence above it, in the one view whose purpose is to put the open rows where somebody
  // will read them. Still-open sorts first now, and within each group the largest total
  // leads.
  const rank = (counts: number[]): [number, number] => [
    counts[counts.length - 1] ? 0 : 1,
    -counts.reduce((a, b) => a + b, 0),
  ];
  const ordered = [...classes].sort((a, b) => {
    const [ra, sa] = rank(a[1]);
    const [rb, sb] = rank(b[1]);
    return ra - rb || sa - sb;
  });
  for (const [cls, counts] of ordered) {
    const cells = counts.map((c) => (c ? String(c) : "·").padEnd(width)).join("");
    const last = counts[counts.length - 1];
    const state = solo ? "" : !last ? "CLOSED" : counts.slice(0, -1).every((c) => !c) ? "NEW" : "";
    console.log(`  ${cells}${state}`);
    console.log(`      ${cls.slice(0, 96)}\n`);
  }
}

/**
 * What changed since a previous report.
 *
 * A single run says where a flow stalled. Whether the flow is getting BETTER is a comparison,
 * and nothing here was keeping one — each report was read once and lost, so "we ran it again
 * and it improved" stayed an impression. The two numbers that answer it are the accepted rate
 * and, more sharply, which refusal CLASSES appeared and which stopped: a class that is gone is
 * a fix, and a class that is new is a regression, whoever caused it.
 */
export function showMovement(now: ReportShape, before: Partial<ReportShape>): void {
  const wasRate = before.accepted_rate ?? 0;
  console.log(`\nsince the report you compared against (${before.calls ?? 0} calls, ${wasRate}% accepted)`);
  console.log("-".repeat(69));
  const delta = now.accepted_rate - wasRate;
  console.log(`  accepted rate ${wasRate}% -> ${now.accepted_rate}% (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`);

  const was = new Map((before.refusals ?? []).map((r) => [r.class, r.count]));
  const isNow = new Map(now.refusals.map((r) => [r.class, r.count]));
  const fixed = [...was.keys()].filter((c) => !isNow.has(c)).sort();
  const fresh = [...isNow.keys()].filter((c) => !was.has(c)).sort();
  for (const cls of fresh) console.log(`  NEW      ${String(isNow.get(cls)).padStart(3)}x  ${cls.slice(0, 110)}`);
  for (const cls of fixed) console.log(`  GONE     ${String(was.get(cls)).padStart(3)}x  ${cls.slice(0, 110)}`);
  for (const cls of [...was.keys()].filter((c) => isNow.has(c)).sort()) {
    if (was.get(cls) !== isNow.get(cls)) {
      console.log(`  ${String(was.get(cls)).padStart(3)} -> ${String(isNow.get(cls)).padEnd(3)}      ${cls.slice(0, 100)}`);
    }
  }
  if (fresh.length === 0 && fixed.length === 0) console.log("  the same refusal classes, in the same shape");
}
