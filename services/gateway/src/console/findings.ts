/**
 * The one sentence a figure is said in, and the local dates it names: chosen here once, so the page and
 * the assistant say the same thing about the same weeks or days. A finding is said only for what the
 * record proves; where nothing holds, a week's finding is null and the page draws none.
 *
 * Pure: no database, no clock. Dates are local (`YYYY-MM-DD`) in the read's timezone, and a sentence
 * prints a day as `28 Sep`.
 */
import type { Measure, MeasureInput, PeriodFigure } from "./figures.js";

export type Finding = {
  kind: "best_week" | "high_week" | "low_week" | "run" | "no_failure" | "count" | "incomplete";
  text: string; dates: string[]; tie: boolean;
};

/** One day of a door, oldest first; `date` is local. */
type Day = { date: string; calls: number | null; toolFailures: number | null; complete: boolean; available: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The local date an instant falls on. en-CA formats as YYYY-MM-DD. */
const localDate = (instant: string, timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(instant));

/** A local date as a sentence prints it: `28 Sep`. */
const day = (date: string): string => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

const count = (n: number): string => n.toLocaleString("en-GB");
const counted = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;

/** A measure's finding about its last complete week, in order: too few comparable weeks to say
 *  anything; the last week is the best (or, for a neutral measure, the highest or lowest) on record;
 *  the last week's counts; else null. A week ties when another comparable complete week has the same
 *  value at the printed precision, and the sentence names the earliest. */
export function weekFinding(measure: Measure, input: MeasureInput): Finding | null {
  const at = (v: number): number => Math.round(v * 10 ** input.precision);
  const comparable = measure.weeks.filter((w) => w.window.complete && w.figure.why === null);
  const last = measure.last;
  const lastDate = last ? [localDate(last.window.from, input.timezone)] : [];
  if (comparable.length < 3 || !last) {
    return { kind: "incomplete", text: "Not enough complete weeks to compare yet", dates: lastDate, tie: false };
  }

  // Whether the last week holds the record `against` names, and the earliest other week it ties with.
  const holds = (against: PeriodFigure | null): { tie: string | null } | null => {
    if (last.figure.why !== null || against === null || at(last.figure.value!) !== at(against.figure.value!)) return null;
    const tied = comparable.find((w) => w !== last && at(w.figure.value!) === at(last.figure.value!));
    return { tie: tied ? localDate(tied.window.from, input.timezone) : null };
  };
  const said = (kind: Finding["kind"], text: string, dates: string[], tie: string | null): Finding =>
    tie === null
      ? { kind, text, dates, tie: false }
      : { kind, text: `${text}, tied with ${day(tie)}`, dates: [...dates, tie], tie: true };

  if (measure.better !== "neutral") {
    const best = holds(measure.best);
    if (best) {
      const which = measure.better === "down" ? "Lowest" : "Highest";
      return said("best_week", `${which} observed ${input.label} in a complete week, ${day(lastDate[0])}`, lastDate, best.tie);
    }
  } else {
    const since = day(input.coverageFrom);
    const high = holds(measure.highest);
    if (high) return said("high_week", `Most recorded ${input.label} in a week since ${since}`, [...lastDate, input.coverageFrom], high.tie);
    const low = holds(measure.lowest);
    if (low) return said("low_week", `Fewest recorded ${input.label} in a week since ${since}`, [...lastDate, input.coverageFrom], low.tie);
  }

  if (last.numerator !== null && last.denominator !== null && input.countLabel !== null) {
    return { kind: "count", text: `${count(last.numerator)} of ${count(last.denominator)} ${input.countLabel}`, dates: lastDate, tie: false };
  }
  return null;
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
