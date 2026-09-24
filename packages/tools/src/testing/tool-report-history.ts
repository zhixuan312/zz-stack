/**
 * The tool report across runs: every saved report as one row per refusal class, and what
 * moved between two of them. Reads a directory of saved reports and touches no database;
 * tool-report.ts answers what the tool surface did in one window, from the platform database.
 *
 * Rows are refusal classes, not accepted rates. A rate is governed by which tools a run
 * happened to call, so calling one failing tool twice instead of nine times moves it several
 * points with nothing fixed. A class is present or it is not.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { die } from "../lib/cli.js";
import { localStamp } from "../lib/shell.js";
import { isReport, type ReportShape } from "./tool-report.js";

/** Every saved run, as one row per refusal class. A row that reaches zero and stays there is a
 * class that was closed; one that never reaches zero is a defect nobody has taken. */
export function showLedger(directory: string): void {
  const files = readdirSync(directory).filter((f) => f.endsWith(".json")).map((f) => join(directory, f));
  if (files.length === 0) die(`no saved reports in ${directory} — write some with --json first`);

  // Parsed once, and what will not parse is named: a stray `notes.json` beside the saved runs
  // would otherwise end --ledger on a raw SyntaxError. Dropped files are counted and listed
  // rather than skipped quietly — this ledger is a claim about runs over time, and a silently
  // dropped denominator is how a comparison lies.
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
    // DELIBERATE: ordered by when each report was taken, not by filename. A hand-named file
    // sorts out of order, which labels a class that closed as new — an improvement printed as
    // a regression.
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

  // One run is a baseline, not a trend: every class in it would otherwise be marked new, which
  // reads as "these just appeared" when it means "nothing preceded this".
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

  // Still-open first, closed last, and within each group the largest total leads. The sort is
  // ascending, so the first key is 0 for a class whose latest count is non-zero.
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
 * Two numbers: the accepted rate, and which refusal classes appeared and which stopped. A
 * class that is gone is a fix; a class that is new is a regression.
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
