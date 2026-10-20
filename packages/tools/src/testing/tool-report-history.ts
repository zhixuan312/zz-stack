/**
 * The tool report across runs: every saved report as one row per refusal class, and what
 * moved between two of them. Reads a directory of saved reports and touches no database;
 * tool-report.ts answers what the tool surface did in one window, from the platform database.
 *
 * Rows are refusal classes, not accepted rates. A rate is governed by which tools a run
 * happened to call, so calling one failing tool twice instead of nine times moves it several
 * points with nothing fixed. A class is present or it is not.
 *
 * Only reports that counted the same calls — the same `origin` — are set side by side. A `work`
 * run has none of chain-check's deliberate refusals and an `all` run has them, so across the two a
 * class reads as closed or new, and the rate moves, by a change of population with nothing fixed.
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
      skipped.push(`${basename(f)} (JSON, but not a report — no calls, refusals or origin)`);
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
  // One series per population, each in the order its runs were taken.
  const series = new Map<ReportShape["origin"], (readonly [string, ReportShape])[]>();
  for (const x of parsed.sort((a, b) => a.taken.localeCompare(b.taken))) {
    series.set(x.report.origin, [...(series.get(x.report.origin) ?? []), [x.name, x.report] as const]);
  }
  for (const [origin, loaded] of series) showSeries(directory, origin, loaded);
}

/** One population's runs, as one row per refusal class. */
function showSeries(directory: string, origin: ReportShape["origin"],
                    loaded: (readonly [string, ReportShape])[]): void {
  // One run is a baseline, not a trend: every class in it would otherwise be marked new, which
  // reads as "these just appeared" when it means "nothing preceded this".
  const solo = loaded.length === 1;
  console.log(
    `\n${loaded.length} run${solo ? "" : "s"} in ${directory} that counted ${origin} calls` +
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
 * class that is gone is a fix; a class that is new is a regression — between two reports that
 * counted the same calls, and only then, so two that did not are refused rather than compared.
 */
export function showMovement(now: ReportShape, before: ReportShape): void {
  if (before.origin !== now.origin) {
    die(`the report compared against counted ${before.origin} calls and this run counted ${now.origin}: ` +
        "between the two, a refusal class and the accepted rate move by which calls were counted, not by " +
        `anything fixed. Run this one again with --origin ${before.origin} to compare them.`);
  }
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
