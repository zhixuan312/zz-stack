#!/usr/bin/env node
/**
 * checks/console-home-title.ts — Home's title and next milestones, as rules over written facts
 * (AC-5.1).
 *
 *   node checks/console-home-title.ts   # needs a built tree (`npm run build`)
 *
 * It calls the gateway's own built `homeTitle` and `nextMilestones`
 * (`services/gateway/dist/console/home-findings.js`) and `periodFinding`, `agentsRunFinding` and
 * `weekFinding` (`services/gateway/dist/console/findings.js`) over facts written here. What it
 * establishes:
 *
 *   - each rule has a fixture where it is the first that holds, answering its own sentence: the first
 *     observed week; a round number of each of the four counts, only in the week it was crossed; a
 *     recorded high with two comparable weeks before it, a tie named; the agents' run newly at 7, 14
 *     and 30, in the reporting timezone's week; a clear rise of at least 25% over a nonzero median of
 *     four prior weeks; the shortest median time to close with its cohort; a quieter week; a plain week;
 *   - rules 2 and 3 are joined and no others; a metric with no coverage wins no rule; within a rule
 *     closed work comes before word additions, approvals in the caller's name and lessons made;
 *     with no weekly count at all the title is `Your work at a glance`; lessons an import cohort made
 *     are not in the facts and fire no milestone;
 *   - the next milestone of each count is the next threshold of its ladder, with the last one passed;
 *   - the agents' run of days is said from seven, `at least` when it reaches the first day given;
 *     `periodFinding` names a high, a low, a best and a tie over periods with no measure key, and
 *     `weekFinding` answers what it answers.
 *
 * Exit 0: every case held. Exit 1: every case that did not, with what came back.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "../scripts/deployment.ts";

const load = (p: string) => import(pathToFileURL(join(root, p)).href);
const H = await load("services/gateway/dist/console/home-findings.js");
const N = await load("services/gateway/dist/console/findings.js");
const F = await load("services/gateway/dist/console/figures.js");

const problems: string[] = [];
const expect = (what: string, ok: boolean, got: unknown) => { if (!ok) problems.push(`${what}: got ${JSON.stringify(got)}`); };

const DAY = 86_400_000;
type Week = {
  window: { from: string; to: string; observedFrom: string; observedThrough: string; complete: boolean };
  closed: number | null; words: number | null; approvals: number | null; lessons: number | null;
  documentsCreated: number | null; medianHoursToClose: { hours: number; cohort: number } | null;
};
// Week i starts on the Monday 31 Aug + 7i, at local midnight `offsetHours` ahead of UTC.
const MONDAYS = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
const wk = (i: number, f: Partial<Week> = {}, complete = true, offsetHours = 0): Week => {
  const start = Date.parse(`${MONDAYS[i]}T00:00:00Z`) - offsetHours * 3_600_000;
  const from = new Date(start).toISOString(), to = new Date(start + 7 * DAY).toISOString();
  return { window: { from, to, observedFrom: from, observedThrough: to, complete },
    closed: null, words: null, approvals: null, lessons: null, documentsCreated: null, medianHoursToClose: null, ...f };
};
type Totals = { closed: number | null; documents: number | null; lessons: number | null; words: number | null };
const NONE: Totals = { closed: null, documents: null, lessons: null, words: null };
const facts = (weeks: Week[], totals: Partial<Totals> = {}, agentDays: { day: string; active: boolean }[] = [], timezone = "UTC") =>
  ({ timezone, weeks, totals: { ...NONE, ...totals }, agentDays });
const title = (what: string, got: { sentence: string; rule: unknown }, rule: unknown, sentence: string) =>
  expect(what, got.rule === rule && got.sentence === sentence, got);

// A history where nothing stands out. Prior closures 4,6,4,6,4 (recent median 5), words 1,000 and
// 3,000 (2,000), approvals 5 and 9 (7), lessons 2 and 4 (3), three documents a week; the last whole
// week is week 5, the running week 6.
const PRIOR = [0, 1, 2, 3, 4].map((i) => wk(i, i % 2
  ? { closed: 6, words: 3000, approvals: 9, lessons: 4, documentsCreated: 3 }
  : { closed: 4, words: 1000, approvals: 5, lessons: 2, documentsCreated: 3 }));
const LAST: Partial<Week> = { closed: 5, words: 2000, approvals: 7, lessons: 3, documentsCreated: 3 };
const RUNNING: Partial<Week> = { closed: 1, words: 0, approvals: 0, lessons: 0, documentsCreated: 0 };
const plain = (last: Partial<Week> = {}, running: Partial<Week> = {}, prior: Week[] = PRIOR) =>
  [...prior, wk(5, { ...LAST, ...last }), wk(6, { ...RUNNING, ...running }, false)];

// Fallback and rule 1: the first observed week.
{
  title("no weeks at all", H.homeTitle(facts([])), "fallback", "Your work at a glance");
  title("no count in the last whole week", H.homeTitle(facts([...PRIOR, wk(5, { documentsCreated: 4 })])), "fallback", "Your work at a glance");
  title("only a running week", H.homeTitle(facts([wk(6, LAST, false)])), "fallback", "Your work at a glance");
  title("first observed week", H.homeTitle(facts([wk(4), wk(5, { closed: 3, words: 0, approvals: null, lessons: 6 })])), 1,
    "Your first observed week: 3 closures and 6 lessons made");
  title("first week before a round number", H.homeTitle(facts([wk(5, { closed: 12 })], { closed: 12 })), 1,
    "Your first observed week: 12 closures");
  title("first week before a quiet week", H.homeTitle(facts([wk(5, { closed: 0, words: null })])), 1,
    "Your first observed week: 0 closures");
}

// Rule 2: a round number, each of the four counts, only in the week it was crossed.
{
  title("50th closure", H.homeTitle(facts(plain(), { closed: 51 })), 2, "Your 50th piece of work closed");
  title("a crossing in an earlier week does not fire", H.homeTitle(facts(plain(), { closed: 56 })), 8,
    "5 pieces of work closed; 2,000 words added to your documents; 7 approvals recorded in your name; 3 lessons made last week");
  expect("a crossing in the running week does not fire", H.homeTitle(facts(plain({}, { closed: 3 }), { closed: 51 })).rule === 8, null);
  expect("the running week's count unknown loses the rule", H.homeTitle(facts(plain({}, { closed: null }), { closed: 51 })).rule === 8, null);
  title("one million words", H.homeTitle(facts(plain(), { words: 1_000_500 })), 2, "One million words added to your documents in all");
  title("one and a half million words", H.homeTitle(facts(plain(), { words: 1_501_000 })), 2, "1.5 million words added to your documents in all");
  title("25th lesson", H.homeTitle(facts(plain(), { lessons: 26 })), 2, "Your 25th lesson made");
  title("100th document", H.homeTitle(facts(plain(), { documents: 101 })), 2, "Your 100th document created");
  title("the highest threshold crossed is named", H.homeTitle(facts(plain({ closed: 5 }), { closed: 26 })), 2, "Your 25th piece of work closed");
  title("closed before words", H.homeTitle(facts(plain(), { closed: 51, words: 1_000_500 })), 2, "Your 50th piece of work closed");
  title("words before lessons", H.homeTitle(facts(plain(), { lessons: 26, words: 1_000_500 })), 2, "One million words added to your documents in all");
  title("lessons before documents", H.homeTitle(facts(plain(), { lessons: 26, documents: 101 })), 2, "Your 25th lesson made");
  // An import of 830 lessons: counted, it would cross 800; outside the cohort, the week made 3.
  title("counted, an import would fire", H.homeTitle(facts(plain({ lessons: 833 }), { lessons: 853 })), 2,
    "Your 800th lesson made, in a week of 833 lessons made, the most yet");
  expect("an import cohort fires no milestone", H.homeTitle(facts(plain(), { lessons: 23 })).rule === 8, H.homeTitle(facts(plain(), { lessons: 23 })));
  expect("a missing total fires nothing", H.homeTitle(facts(plain(), { closed: null })).rule === 8, null);
}

// Rule 3: a recorded high, with at least two comparable weeks before it, every tied week named; joined with rule 2.
{
  title("recorded high, ahead of a clear rise", H.homeTitle(facts(plain({ closed: 7 }))), 3,
    "7 pieces of work closed last week, the most in a week yet");
  title("a tie is named", H.homeTitle(facts(plain({ closed: 6 }))), 3,
    "6 pieces of work closed last week, the most in a week yet, tied with the weeks of 7 Sept and 21 Sept");
  title("words high", H.homeTitle(facts(plain({ words: 3500 }))), 3,
    "3,500 words added to your documents last week, the most in a week yet");
  title("closed before words", H.homeTitle(facts(plain({ closed: 7, words: 3500 }))), 3,
    "7 pieces of work closed last week, the most in a week yet");
  title("approvals before lessons", H.homeTitle(facts(plain({ approvals: 10, lessons: 5 }))), 3,
    "10 approvals recorded in your name last week, the most in a week yet");
  title("two comparable weeks before it", H.homeTitle(facts([PRIOR[3], PRIOR[4], wk(5, { closed: 9 })])), 3,
    "9 pieces of work closed last week, the most in a week yet");
  title("one comparable week before it is not a record", H.homeTitle(facts([PRIOR[4], wk(5, { closed: 9 })])), 8,
    "9 pieces of work closed last week");
  // Words recorded in only one earlier week: 5,000 cannot be a high or a rise.
  const thin = PRIOR.map((w, i) => ({ ...w, words: i === 4 ? 1000 : null }));
  title("a metric with no coverage wins no rule", H.homeTitle(facts(plain({ words: 5000 }, {}, thin))), 8,
    "5 pieces of work closed; 5,000 words added to your documents; 7 approvals recorded in your name; 3 lessons made last week");
  title("a missing count is left out", H.homeTitle(facts(plain({ words: null }))), 8,
    "5 pieces of work closed; 7 approvals recorded in your name; 3 lessons made last week");
  const zeros = PRIOR.map((w) => ({ ...w, approvals: 0 }));
  expect("a high of zero is no record", H.homeTitle(facts(plain({ approvals: 0 }, {}, zeros))).rule === 8, H.homeTitle(facts(plain({ approvals: 0 }, {}, zeros))));
  title("rules 2 and 3 joined", H.homeTitle(facts(plain({ words: 3500 }), { closed: 51 })), 2,
    "Your 50th piece of work closed, in a week of 3,500 words added, the most yet");
  title("joined with a tie", H.homeTitle(facts(plain({ closed: 6 }), { closed: 51 })), 2,
    "Your 50th piece of work closed, in a week of 6 closures, the most yet, tied with the weeks of 7 Sept and 21 Sept");
  // The first comparable week tied: closures from the week of 7 Sept, the last whole week 28 Sept.
  const fromSept7 = (closed: number[]) => closed.map((n, i) => wk(i + 1, { closed: n }));
  title("a tie with the first comparable week alone", H.homeTitle(facts(fromSept7([6, 2, 3, 6]))), 3,
    "6 pieces of work closed last week, the most in a week yet, tied with the week of 7 Sept");
  title("a tie with the first comparable week and a later one", H.homeTitle(facts(fromSept7([6, 2, 6, 6]))), 3,
    "6 pieces of work closed last week, the most in a week yet, tied with the weeks of 7 Sept and 21 Sept");
  title("joined with a tie with the first comparable week", H.homeTitle(facts(fromSept7([6, 2, 3, 6]), { closed: 51 })), 2,
    "Your 50th piece of work closed, in a week of 6 closures, the most yet, tied with the week of 7 Sept");
}

// Rule 4: the agents' run of days, newly at 7, 14 or 30 inside the last whole week.
const days = (from: string, through: string, inactive: string[] = []) => {
  const out: { day: string; active: boolean }[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${through}T00:00:00Z`); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, active: !inactive.includes(day) });
  }
  return out;
};
{
  title("14 days in a row", H.homeTitle(facts(plain(), {}, days("2026-09-27", "2026-10-13", ["2026-09-27"]))), 4, "Your agents ran 14 days in a row");
  title("7 days in a row, reached midweek", H.homeTitle(facts(plain(), {}, days("2026-09-20", "2026-10-13", ["2026-10-01", "2026-10-09"]))), 4,
    "Your agents ran 7 days in a row");
  title("30 days in a row", H.homeTitle(facts(plain(), {}, days("2026-09-01", "2026-10-13", ["2026-09-11"]))), 4, "Your agents ran 30 days in a row");
  expect("a run already past its threshold is not new", H.homeTitle(facts(plain(), {}, days("2026-09-01", "2026-10-13", ["2026-09-20"]))).rule === 8, null);
  expect("a run reached after the week is not this week's", H.homeTitle(facts(plain(), {}, days("2026-10-01", "2026-10-13", ["2026-10-05"]))).rule === 8, null);
  expect("a run of unknown length never fires", H.homeTitle(facts(plain(), {}, days("2026-09-12", "2026-10-13"))).rule === 8, null);
  // Singapore: the week is Monday 5 Oct to Sunday 11 Oct local, its instants eight hours earlier.
  const sg = [0, 1, 2, 3, 4].map((i) => ({ ...PRIOR[i], window: wk(i, {}, true, 8).window }));
  const sgWeeks = [...sg, wk(5, LAST, true, 8), wk(6, RUNNING, false, 8)];
  title("the week is the reporting timezone's", H.homeTitle(facts(sgWeeks, {}, days("2026-10-04", "2026-10-11", ["2026-10-04"]), "Asia/Singapore")), 4,
    "Your agents ran 7 days in a row");
  expect("a local Monday after the week is not in it", H.homeTitle(facts(sgWeeks, {}, days("2026-10-05", "2026-10-12", ["2026-10-05"]), "Asia/Singapore")).rule === 8, null);
  title("rule 3 before rule 4, not joined", H.homeTitle(facts(plain({ closed: 7 }), {}, days("2026-09-27", "2026-10-13", ["2026-09-27"]))), 3,
    "7 pieces of work closed last week, the most in a week yet");
}

// Rule 5: a clear rise over the median of four prior weeks, nonzero.
{
  title("25% above the median", H.homeTitle(facts(plain({ words: 2500 }))), 5, "25% more words added to your documents than your recent weekly median");
  expect("under 25% is no rise", H.homeTitle(facts(plain({ words: 2499 }))).rule === 8, null);
  const approvals = PRIOR.map((w, i) => ({ ...w, approvals: [5, 30, 5, 9, 5][i] }));
  title("times the median", H.homeTitle(facts(plain({ approvals: 15 }, {}, approvals))), 5,
    "2.1 times as many approvals recorded in your name as your recent weekly median");
  const closed = PRIOR.map((w, i) => ({ ...w, closed: [9, 4, 6, 4, 6][i] }));
  title("closed before words", H.homeTitle(facts(plain({ closed: 7, words: 2500 }, {}, closed))), 5,
    "40% more pieces of work closed than your recent weekly median");
  const lessons = PRIOR.map((w, i) => ({ ...w, lessons: [5, 0, 0, 0, 0][i] }));
  expect("a zero median is no rise", H.homeTitle(facts(plain({ lessons: 3 }, {}, lessons))).rule === 8, H.homeTitle(facts(plain({ lessons: 3 }, {}, lessons))));
  expect("three prior weeks are not four", H.homeTitle(facts(plain({ words: 2900 }, {}, PRIOR.slice(2)))).rule === 8, H.homeTitle(facts(plain({ words: 2900 }, {}, PRIOR.slice(2)))));
  title("rule 4 before rule 5, not joined", H.homeTitle(facts(plain({ words: 2500 }), {}, days("2026-09-27", "2026-10-13", ["2026-09-27"]))), 4,
    "Your agents ran 14 days in a row");
}

// Rule 6: the shortest median time to close among comparable weeks, with its cohort.
{
  const times = [{ hours: 10, cohort: 2 }, { hours: 8, cohort: 3 }, { hours: 12, cohort: 1 }, { hours: 9, cohort: 2 }, { hours: 11, cohort: 2 }];
  const timed = PRIOR.map((w, i) => ({ ...w, medianHoursToClose: times[i] }));
  title("shortest median time to close", H.homeTitle(facts(plain({ medianHoursToClose: { hours: 6.04, cohort: 5 } }, {}, timed))), 6,
    "The shortest median time to close yet: 6 hours, over 5 pieces of work");
  title("a tie is named", H.homeTitle(facts(plain({ medianHoursToClose: { hours: 8, cohort: 4 } }, {}, timed))), 6,
    "The shortest median time to close yet: 8 hours, over 4 pieces of work, tied with the week of 7 Sept");
  expect("not the shortest", H.homeTitle(facts(plain({ medianHoursToClose: { hours: 8.5, cohort: 4 } }, {}, timed))).rule === 8, null);
  expect("no week's median is no rule", H.homeTitle(facts(plain({ medianHoursToClose: null }, {}, timed))).rule === 8, null);
  expect("rule 5 before rule 6", H.homeTitle(facts(plain({ words: 2500, medianHoursToClose: { hours: 6, cohort: 5 } }, {}, timed))).rule === 5, null);
}

// Rules 7 and 8: a quieter week, a plain week.
{
  title("a quieter week", H.homeTitle(facts(plain({ closed: 3 }))), 7, "A quieter week: 3 pieces of work closed");
  title("a quieter week with none closed", H.homeTitle(facts(plain({ closed: 0, words: 1000 }))), 7, "A quieter week: 0 pieces of work closed");
  title("rule 5 before a quieter week", H.homeTitle(facts(plain({ closed: 3, words: 2500 }))), 5,
    "25% more words added to your documents than your recent weekly median");
  title("a plain week", H.homeTitle(facts(plain())), 8,
    "5 pieces of work closed; 2,000 words added to your documents; 7 approvals recorded in your name; 3 lessons made last week");
  title("a plain week names what was counted above zero", H.homeTitle(facts(plain({ words: 0, lessons: 0 }))), 8,
    "5 pieces of work closed; 7 approvals recorded in your name last week");
}

// Home's next milestones.
{
  const m = H.nextMilestones({ closed: 51, documents: 1234, lessons: 100, words: 1_620_000 });
  expect("one milestone a count, in order", JSON.stringify(m) === JSON.stringify([
    { count: "closed", next: 100, last: 50, value: 51 },
    { count: "documents", next: 2000, last: 1000, value: 1234 },
    { count: "lessons", next: 200, last: 100, value: 100 },
    { count: "words", next: 2_000_000, last: 1_500_000, value: 1_620_000 },
  ]), m);
  const at = (c: string, v: number) => H.nextMilestones({ ...NONE, [c]: v })[0];
  expect("nothing reached yet", JSON.stringify(at("closed", 0)) === JSON.stringify({ count: "closed", next: 10, last: 0, value: 0 }), at("closed", 0));
  expect("past the listed ladder", JSON.stringify(at("closed", 1499)) === JSON.stringify({ count: "closed", next: 1500, last: 1000, value: 1499 }), at("closed", 1499));
  expect("exactly on a threshold", JSON.stringify(at("closed", 500)) === JSON.stringify({ count: "closed", next: 1000, last: 500, value: 500 }), at("closed", 500));
  expect("documents' ladder", at("documents", 99).next === 100 && at("documents", 500).next === 1000 && at("documents", 3000).next === 4000, null);
  expect("lessons' ladder", at("lessons", 24).next === 25 && at("lessons", 24).last === 10 && at("lessons", 450).next === 500, null);
  expect("words' ladder", at("words", 999_999).next === 1_000_000 && at("words", 999_999).last === 0 && at("words", 2_400_000).last === 2_000_000, null);
  expect("a count with no total is not listed", H.nextMilestones({ ...NONE, lessons: 3 }).length === 1, H.nextMilestones({ ...NONE, lessons: 3 }));
}

// The agents' run of days among Phase 1's findings.
{
  const run = N.agentsRunFinding(days("2026-09-27", "2026-10-11", ["2026-09-27"]));
  expect("the run sentence", run?.kind === "run" && run.text === "Your agents ran 14 days in a row" && run.dates[0] === "2026-10-11" && run.tie === false, run);
  expect("under seven days is no finding", N.agentsRunFinding(days("2026-10-04", "2026-10-11", ["2026-10-05"])) === null, null);
  expect("a last day with no call ends it", N.agentsRunFinding(days("2026-09-27", "2026-10-11", ["2026-10-11"])) === null, null);
  const all = N.agentsRunFinding(days("2026-10-03", "2026-10-11"));
  expect("reaching the first day given is at least", all?.text === "Your agents ran at least 9 days in a row", all);
  expect("no days, no finding", N.agentsRunFinding([]) === null, null);
}

// periodFinding: the dated high and low with no measure key; weekFinding answers through it.
{
  const p = (i: number, value: number | null, complete = true) => ({
    window: wk(i, {}, complete).window, numerator: null, denominator: null,
    figure: value === null ? { value: null, why: "no_data" } : { value, why: null },
  });
  const o = { label: "words added", better: "neutral", timezone: "UTC", precision: 0, coverageFrom: null, countLabel: null };
  const high = N.periodFinding([p(2, 40), p(3, 20), p(4, 90), p(5, 10, false)], o);
  expect("a high with no stated start", high?.kind === "high_week" && high.text === "Most recorded words added in a week since 14 Sept" && high.dates.join() === "2026-09-28,2026-09-14", high);
  const since = N.periodFinding([p(2, 40), p(3, 20), p(4, 90)], { ...o, coverageFrom: "2026-09-01" });
  expect("a high since the record began", since?.text === "Most recorded words added in a week since 1 Sept", since);
  const low = N.periodFinding([p(2, 40), p(3, 90), p(4, 40)], o);
  expect("a low, tied with the week it is counted from", low?.kind === "low_week" && low.tie === true
    && low.text === "Fewest recorded words added in a week since 14 Sept, tied with that first week" && low.dates.join() === "2026-09-28,2026-09-14", low);
  const best = N.periodFinding([p(2, 9), p(3, 8), p(4, 6)], { ...o, label: "median hours to close", better: "down", precision: 1 });
  expect("a best", best?.kind === "best_week" && best.text === "Lowest observed median hours to close in a complete week, 28 Sept", best);
  expect("a gap leaves too few", N.periodFinding([p(2, 40), p(3, null), p(4, 90)], o)?.kind === "incomplete", null);
  expect("no rule and no counts", N.periodFinding([p(2, 40), p(3, 90), p(4, 60)], o) === null, null);
  const counted = N.periodFinding([{ ...p(2, 3), numerator: 3, denominator: 100 }, { ...p(3, 4), numerator: 4, denominator: 100 }, { ...p(4, 5), numerator: 5, denominator: 100 }],
    { ...o, better: "down", countLabel: "calls refused" });
  expect("the last period's counts", counted?.kind === "count" && counted.text === "5 of 100 calls refused", counted);

  const input = { key: "sessions", better: "neutral", minSamples: 0, precision: 0, definedFrom: null, label: "sessions", countLabel: null,
    coverageFrom: "2026-09-14", timezone: "UTC",
    weeks: [40, 20, 90].map((v, i) => { const w = wk(i + 2).window; return { ...w, numerator: v, denominator: 1, value: v, samples: 1, available: true }; }) };
  const measure = F.summarise(input);
  const direct = N.periodFinding(measure.weeks, { label: "sessions", better: "neutral", timezone: "UTC", precision: 0, coverageFrom: "2026-09-14", countLabel: null });
  expect("weekFinding answers through periodFinding", JSON.stringify(N.weekFinding(measure, input)) === JSON.stringify(direct) && direct?.kind === "high_week", direct);
}

if (problems.length) { console.error(`console-home-title: FAILED\n  ${problems.join("\n  ")}`); process.exitCode = 1; }
else console.log("console-home-title: each rule is the first that holds in its fixture, and the milestones follow their ladders: ok");
