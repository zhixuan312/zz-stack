/**
 * Home's title and next milestones: rules over the last whole week's facts, so the page and the
 * assistant say the same sentence about the same week.
 *
 * The title's rules are tested in order and the first that holds writes it: 1 the first observed
 * week, 2 a round number crossed, 3 a recorded high, 4 the agents' run of days newly at 7, 14 or 30,
 * 5 a clear rise over the recent weekly median, 6 the shortest median time to close, 7 a quieter
 * week, 8 a plain week; with no weekly count at all, the fixed fallback. Rules 2 and 3 may be joined,
 * and no others. A missing fact is null and loses every rule that needs it. Within a rule the metric
 * priority is closed work, word additions, approvals in the caller's name, lesson adoptions; a round
 * number of documents created comes after those. The title is worded for a team of one, never asks
 * for another day of work and never says whether the person rested.
 *
 * Pure: no database, no clock. Every count is the caller's to make: lessons outside import cohorts,
 * words as recorded net additions, approvals in the caller's name alone, so an import never fires a
 * milestone here because it is never in these facts.
 *
 * COUPLED: the console's Home and Milestone in src/lib/work-shapes.ts.
 */
import type { PeriodFigure, Window } from "./figures.js";
import { agentsRunOf, count, days, localDate, periodFinding, type AgentDay, type Finding } from "./findings.js";

/** One week of the team's facts, oldest first; the running week, when there is one, last. */
type HomeWeek = {
  window: Window;
  closed: number | null; words: number | null; approvals: number | null; lessons: number | null;
  documentsCreated: number | null;
  medianHoursToClose: { hours: number; cohort: number } | null;
};
/** The facts the title and milestones are chosen from. `totals` are as of the cutoff, the running
 *  week's counts included; `agentDays` are whole local days, oldest first, reaching back far enough to
 *  decide a run of 30; `timezone` is the reporting timezone the weeks were cut in. */
export type HomeFacts = {
  timezone: string;
  weeks: HomeWeek[];
  totals: { closed: number | null; documents: number | null; lessons: number | null; words: number | null };
  agentDays: AgentDay[];
};
type HomeTitle = { sentence: string; rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | "fallback" };
export type Milestone = { count: "closed" | "documents" | "lessons" | "words"; next: number; last: number; value: number };

type Metric = "closed" | "words" | "approvals" | "lessons";
const PRIORITY: Metric[] = ["closed", "words", "approvals", "lessons"];
/** What a count of each metric is called: in a list of the week's tallies, and as a thing done. */
const TALLY: Record<Metric, [string, string]> = {
  closed: ["closure", "closures"], words: ["word added", "words added"],
  approvals: ["approval in your name", "approvals in your name"], lessons: ["lesson adoption", "lesson adoptions"],
};
const DONE: Record<Metric, [string, string]> = {
  closed: ["piece of work closed", "pieces of work closed"],
  words: ["word added to your documents", "words added to your documents"],
  approvals: ["approval recorded in your name", "approvals recorded in your name"],
  lessons: ["lesson adopted", "lessons adopted"],
};
const say = (n: number, [one, many]: [string, string]): string => `${count(n)} ${n === 1 ? one : many}`;

/** Each count's round numbers: the listed thresholds, then every further step. */
const LADDERS: Record<Milestone["count"], { steps: number[]; every: number }> = {
  closed: { steps: [10, 25, 50, 100, 250, 500], every: 500 },
  documents: { steps: [100, 500, 1_000], every: 1_000 },
  lessons: { steps: [10, 25, 50, 100], every: 100 },
  words: { steps: [1_000_000], every: 500_000 },
};
/** The highest round number a value has reached, or 0 with none. */
function reached(c: Milestone["count"], value: number): number {
  const { steps, every } = LADDERS[c];
  const top = steps.at(-1)!;
  if (value >= top) return top + Math.floor((value - top) / every) * every;
  return [...steps].reverse().find((t) => t <= value) ?? 0;
}
/** The first round number a value has not reached. */
function nextAfter(c: Milestone["count"], value: number): number {
  const { steps, every } = LADDERS[c];
  const top = steps.at(-1)!;
  return steps.find((t) => t > value) ?? top + (Math.floor((value - top) / every) + 1) * every;
}

/** The next round number of each count with a total, with the last one passed and the total. */
export function nextMilestones(totals: HomeFacts["totals"]): Milestone[] {
  return (["closed", "documents", "lessons", "words"] as const).flatMap((c) => {
    const value = totals[c];
    return value === null ? [] : [{ count: c, next: nextAfter(c, value), last: reached(c, value), value }];
  });
}

const ordinal = (n: number): string => {
  const tens = n % 100, ones = n % 10;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th";
  return `${count(n)}${suffix}`;
};
const ROUND: Record<Milestone["count"], (t: number) => string> = {
  closed: (t) => `Your ${ordinal(t)} piece of work closed`,
  documents: (t) => `Your ${ordinal(t)} document created`,
  lessons: (t) => `Your ${ordinal(t)} lesson adopted`,
  words: (t) => `${t === 1_000_000 ? "One" : count(t / 1_000_000)} million words added to your documents in all`,
};
/** Rule 2's counts in the order they are tested, with the weekly fact each total is counted by. */
const ROUND_ORDER: [Milestone["count"], keyof HomeWeek][] =
  [["closed", "closed"], ["words", "words"], ["lessons", "lessons"], ["documents", "documentsCreated"]];

/** The median of a non-empty list. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const hours = (h: number): string => { const r = Math.round(h * 10) / 10; return `${count(r)} ${r === 1 ? "hour" : "hours"}`; };
/** The weeks a finding ties with: its dates after the week itself and, for a high or a low, the week its record runs
 *  from (periodFinding's order). */
const tiesOf = (f: Finding): string[] => f.dates.slice(f.kind === "best_week" ? 1 : 2);
const tied = (f: Finding): string => {
  const ties = tiesOf(f);
  return f.tie ? `, tied with the ${ties.length > 1 ? "weeks" : "week"} of ${days(ties)}` : "";
};

/** The sentence Home is titled with, and the rule that wrote it. */
export function homeTitle(facts: HomeFacts): HomeTitle {
  let at = facts.weeks.length - 1;
  while (at >= 0 && !facts.weeks[at].window.complete) at--;
  const week = facts.weeks[at];
  if (!week || PRIORITY.every((m) => week[m] === null)) return { sentence: "Your work at a glance", rule: "fallback" };
  const prior = facts.weeks.slice(0, at).filter((w) => w.window.complete);
  const later = facts.weeks.slice(at + 1);

  // The week's tallies: those above zero, or with none, the first one counted.
  const tallies = (words: Record<Metric, [string, string]>): string[] => {
    const known = PRIORITY.filter((m) => week[m] !== null);
    const some = known.filter((m) => week[m]! > 0);
    return (some.length ? some : known.slice(0, 1)).map((m) => say(week[m]!, words[m]));
  };

  // 1. No earlier complete week counted anything.
  if (prior.every((w) => PRIORITY.every((m) => w[m] === null))) {
    const list = tallies(TALLY);
    const said = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
    return { sentence: `Your first observed week: ${said}`, rule: 1 };
  }

  // 2. A total crossed a round number during the week: from before the week to its end.
  const round = ROUND_ORDER.map(([c, key]) => {
    const total = facts.totals[c], here = week[key] as number | null;
    const since = later.map((w) => w[key] as number | null);
    if (total === null || here === null || since.some((v) => v === null)) return null;
    const end = total - since.reduce<number>((n, v) => n + v!, 0);
    const crossed = reached(c, end);
    return crossed > 0 && crossed > end - here ? ROUND[c](crossed) : null;
  }).find((s) => s !== null);

  // 3. The week equals the highest of at least three comparable complete weeks, and is above zero.
  const high = PRIORITY.map((m) => {
    const value = week[m];
    if (value === null || value <= 0) return null;
    const periods = facts.weeks.map((w): PeriodFigure => ({
      window: w.window, numerator: null, denominator: null,
      figure: w[m] === null ? { value: null, why: "unavailable" } : { value: w[m], why: null },
    }));
    const f = periodFinding(periods, { label: m, better: "neutral", timezone: facts.timezone, precision: 0, coverageFrom: null, countLabel: null });
    return f?.kind === "high_week" ? { m, value, f } : null;
  }).find((h) => h !== null);

  if (round && high) return { sentence: `${round}, in a week of ${say(high.value, TALLY[high.m])}, the most yet${tied(high.f)}`, rule: 2 };
  if (round) return { sentence: round, rule: 2 };
  if (high) return { sentence: `${say(high.value, DONE[high.m])} last week, the most in a week yet${tied(high.f)}`, rule: 3 };

  // 4. On a day of the week the agents' run newly reached 7, 14 or 30; a run that reaches the first
  //    day given is of unknown length and never fires.
  const first = localDate(week.window.from, facts.timezone), end = localDate(week.window.to, facts.timezone);
  const run = facts.agentDays.flatMap((d, i) => {
    if (d.day < first || d.day >= end) return [];
    const r = agentsRunOf(facts.agentDays.slice(0, i + 1));
    return r && !r.atLeast && [7, 14, 30].includes(r.days) ? [r.days] : [];
  }).at(-1);
  if (run !== undefined) return { sentence: `Your agents ran ${run} days in a row`, rule: 4 };

  // The median of a metric over the four latest earlier weeks that counted it, or null with fewer.
  const recent = (m: Metric): number | null => {
    const values = prior.map((w) => w[m]).filter((v): v is number => v !== null).slice(-4);
    return values.length === 4 ? median(values) : null;
  };

  // 5. At least a quarter above a nonzero recent median.
  const rise = PRIORITY.map((m) => {
    const value = week[m], base = recent(m);
    return value !== null && base !== null && base > 0 && value * 100 >= base * 125 ? { m, value, base } : null;
  }).find((r) => r !== null);
  if (rise) {
    const many = DONE[rise.m][1];
    const sentence = rise.value >= 2 * rise.base
      ? `${count(Math.floor((10 * rise.value) / rise.base) / 10)} times as many ${many} as your recent weekly median`
      : `${Math.floor((100 * (rise.value - rise.base)) / rise.base)}% more ${many} than your recent weekly median`;
    return { sentence, rule: 5 };
  }

  // 6. The week's median time to close is the lowest of at least three comparable complete weeks.
  if (week.medianHoursToClose !== null) {
    const periods = facts.weeks.map((w): PeriodFigure => ({
      window: w.window, numerator: null, denominator: w.medianHoursToClose?.cohort ?? null,
      figure: w.medianHoursToClose === null ? { value: null, why: "no_data" } : { value: w.medianHoursToClose.hours, why: null },
    }));
    const f = periodFinding(periods, { label: "median time to close", better: "down", timezone: facts.timezone, precision: 1, coverageFrom: null, countLabel: null });
    if (f?.kind === "best_week") {
      const { hours: h, cohort } = week.medianHoursToClose;
      return { sentence: `The shortest median time to close yet: ${hours(h)}, over ${say(cohort, ["piece of work", "pieces of work"])}${tied(f)}`, rule: 6 };
    }
  }

  // 7. Fewer closures than the recent median.
  const closedBase = recent("closed");
  if (week.closed !== null && closedBase !== null && week.closed < closedBase) {
    return { sentence: `A quieter week: ${say(week.closed, DONE.closed)}`, rule: 7 };
  }

  // 8. The week's counts as they are.
  return { sentence: `${tallies(DONE).join("; ")} last week`, rule: 8 };
}
