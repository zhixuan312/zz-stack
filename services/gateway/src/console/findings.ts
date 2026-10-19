/**
 * The one sentence a figure is said in, and the local dates it names: chosen here once, so the page and
 * the assistant say the same thing about the same weeks or days. A finding is said only for what the
 * record proves; where nothing holds, a week's finding is null and the page draws none.
 *
 * Pure: no database, no clock. Dates are local (`YYYY-MM-DD`) in the read's timezone, and a sentence
 * prints a day as the console does, `28 Sept`.
 */
import type { Measure, MeasureInput, PeriodFigure } from "./figures.js";

export type Finding = {
  kind: "best_week" | "high_week" | "low_week" | "run" | "no_failure" | "count" | "incomplete";
  text: string; dates: string[]; tie: boolean;
};

/** One day of a door, oldest first; `date` is local. */
type Day = { date: string; calls: number | null; toolFailures: number | null; complete: boolean; available: boolean };
/** One whole local day of a team's agents, oldest first: whether it had a real-work call. */
export type AgentDay = { day: string; active: boolean };

/** The local date an instant falls on. en-CA formats as YYYY-MM-DD. */
export const localDate = (instant: string, timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(instant));

/** A calendar day as the console writes one in a sentence (its `formatDay`): en-GB's day and short month. The date
 *  is already local, so it is read as that day in UTC. */
const SENTENCE_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

/** A local date as a sentence prints it: `28 Sept`, `1 Oct`. */
export const day = (date: string): string =>
  SENTENCE_DAY.format(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));

/** Local dates as a sentence lists them: `14 Sept`, `14 Sept and 28 Sept`, `7 Sept, 14 Sept and 28 Sept`. */
export const days = (dates: string[]): string => {
  const said = dates.map(day);
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0];
};

/** A count as a sentence prints it: `496,000`. */
export const count = (n: number): string => n.toLocaleString("en-GB");
const counted = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;

/** What a finding over periods needs to say it: the words that name the figure, its favourable
 *  direction, the reporting timezone, the decimals the page prints, the local date the record begins
 *  (null when it begins with the first period given) and the words after a count (null for a figure
 *  with no numerator). */
type PeriodFindingOptions = {
  label: string; better: "up" | "down" | "neutral"; timezone: string; precision: number;
  coverageFrom: string | null; countLabel: string | null;
};

/** A finding about the last complete period, in order: too few comparable periods to say anything;
 *  the last period is the best (or, for a neutral figure, the highest or lowest) on record; the last
 *  period's counts; else null. Comparable is complete with a standing value, and every record is chosen
 *  among those alone: a period too thin to stand neither holds a record nor takes one from a period that
 *  stands. A period ties when another comparable complete period has the same value at the printed
 *  precision, and the sentence names every period it ties with, earliest first. */
export function periodFinding(periods: PeriodFigure[], options: PeriodFindingOptions): Finding | null {
  const at = (v: number): number => Math.round(v * 10 ** options.precision);
  const whole = periods.filter((p) => p.window.complete);
  const comparable = whole.filter((p) => p.figure.why === null);
  const last = whole.at(-1) ?? null;
  const lastDate = last ? [localDate(last.window.from, options.timezone)] : [];
  if (comparable.length < 3 || !last) {
    return { kind: "incomplete", text: "Not enough complete weeks to compare yet", dates: lastDate, tie: false };
  }

  // The record among `from` in `ahead`'s order; the first strictly ahead wins, so a tie keeps the earliest.
  const record = (from: PeriodFigure[], ahead: (a: number, b: number) => boolean): PeriodFigure | null =>
    from.reduce<PeriodFigure | null>((b, p) => (b === null || ahead(at(p.figure.value!), at(b.figure.value!)) ? p : b), null);
  const below = (a: number, b: number): boolean => a < b;
  const above = (a: number, b: number): boolean => a > b;
  // Whether the last period holds the record `against` names, and every other period it ties with, earliest first.
  const holds = (against: PeriodFigure | null): { ties: string[] } | null => {
    if (last.figure.why !== null || against === null || at(last.figure.value!) !== at(against.figure.value!)) return null;
    const tied = comparable.filter((p) => p !== last && at(p.figure.value!) === at(last.figure.value!));
    return { ties: tied.map((p) => localDate(p.window.from, options.timezone)) };
  };
  const said = (kind: Finding["kind"], text: string, dates: string[], ties: string[]): Finding =>
    ties.length === 0
      ? { kind, text, dates, tie: false }
      : { kind, text: `${text}, tied with ${days(ties)}`, dates: [...dates, ...ties], tie: true };

  if (options.better !== "neutral") {
    const best = holds(record(comparable, options.better === "down" ? below : above));
    if (best) {
      const which = options.better === "down" ? "Lowest" : "Highest";
      return said("best_week", `${which} observed ${options.label} in a complete week, ${day(lastDate[0])}`, lastDate, best.ties);
    }
  } else {
    // With no stated start, the record begins with the first comparable period given.
    const from = options.coverageFrom ?? localDate(comparable[0].window.from, options.timezone);
    const high = holds(record(comparable, above));
    if (high) return said("high_week", `Most recorded ${options.label} in a week since ${day(from)}`, [...lastDate, from], high.ties);
    const low = holds(record(comparable, below));
    if (low) return said("low_week", `Fewest recorded ${options.label} in a week since ${day(from)}`, [...lastDate, from], low.ties);
  }

  if (last.numerator !== null && last.denominator !== null && options.countLabel !== null) {
    return { kind: "count", text: `${count(last.numerator)} of ${count(last.denominator)} ${options.countLabel}`, dates: lastDate, tie: false };
  }
  return null;
}

/** A measure's finding about its last complete week: `periodFinding` over its weeks. */
export function weekFinding(measure: Measure, input: MeasureInput): Finding | null {
  return periodFinding(measure.weeks, {
    label: input.label, better: input.better, timezone: input.timezone, precision: input.precision,
    coverageFrom: input.coverageFrom, countLabel: input.countLabel,
  });
}

/** A day that keeps a run going: complete, available, with calls, and tool failures under 1% of them. */
const under = (d: Day): boolean =>
  d.complete && d.available && d.calls !== null && d.calls > 0 && d.toolFailures !== null && d.toolFailures * 100 < d.calls;

/** The run of days under 1% tool failures that ends on the latest complete day; today, still running,
 *  is set aside. A day with no calls, an unavailable day or one at 1% or more ends it. `atLeast` when
 *  it reaches the first day given, since the days before it were not read. Null under three days. */
export function runOf(days: Day[]): { days: number; atLeast: boolean; through: string } | null {
  let end = days.length - 1;
  while (end >= 0 && !days[end].complete) end--;
  let start = end;
  while (start >= 0 && under(days[start])) start--;
  const length = end - start;
  return length < 3 ? null : { days: length, atLeast: start < 0, through: days[end].date };
}

/** The agents' run of days that ends on the last day given, every day given being whole: days with a
 *  real-work call, one with none ending it. `atLeast` when it reaches the first day given. Null under
 *  three days, as `runOf`. */
export function agentsRunOf(days: AgentDay[]): { days: number; atLeast: boolean; through: string } | null {
  return runOf(days.map((d) => ({ date: d.day, calls: d.active ? 1 : 0, toolFailures: 0, complete: true, available: true })));
}

/** The agents' run of days, said once it reaches seven: what the agents did, never what the person did. */
export function agentsRunFinding(days: AgentDay[]): Finding | null {
  const run = agentsRunOf(days);
  if (!run || run.days < 7) return null;
  return { kind: "run", text: `Your agents ran ${run.atLeast ? "at least " : ""}${run.days} days in a row`, dates: [run.through], tie: false };
}

/** A door's finding about its days, in order: no tool failure recorded on any day, counting every
 *  day's calls, today's included; else its run; else its counts. */
export function runFinding(days: Day[]): Finding {
  const calls = days.reduce((n, d) => n + (d.calls ?? 0), 0);
  const failures = days.reduce((n, d) => n + (d.toolFailures ?? 0), 0);
  if (days.length > 0 && failures === 0) {
    return { kind: "no_failure", text: `No tool failure recorded in ${counted(calls, "call", "calls")} since ${day(days[0].date)}`,
             dates: [days[0].date], tie: false };
  }
  const run = runOf(days);
  if (run) {
    return { kind: "run", text: `${run.atLeast ? "At least " : ""}${run.days} days in a row under 1% tool failures, to ${day(run.through)}`,
             dates: [run.through], tie: false };
  }
  return { kind: "count", text: `${counted(failures, "tool failure", "tool failures")} in ${counted(calls, "call", "calls")}`, dates: [], tie: false };
}
