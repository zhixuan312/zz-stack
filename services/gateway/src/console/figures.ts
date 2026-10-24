/**
 * The shapes every figure a platform read draws arrives in, and the one function that turns weeks of
 * counts into a measure: its weeks, the weeks it names (first, best, last, previous, highest, lowest),
 * its judgement and its finding.
 *
 * Pure: no database, no clock. A read counts its own weeks and hands them here, so two reads of the
 * same counts can never pick a different best week or judge them differently.
 *
 * COUPLED: the console's types in src/lib/platform-shapes.ts, and the spec's metric shapes they copy.
 */
import { weekFinding, type Finding } from "./findings.js";

export type Figure = {
  value: number | null;
  why: "no_data" | "insufficient" | "unavailable" | null;   // null when the value stands
};
export type Window = {
  from: string; to: string;       // requested half-open interval [from, to)
  observedFrom: string | null; observedThrough: string | null;
  complete: boolean;              // ended AND fully observed under this definition
};
export type PeriodFigure = {
  window: Window; figure: Figure;
  numerator: number | null; denominator: number | null;
};
export type ReadMeta = {
  asOf: string; timezone: string;
  period: { from: string; to: string };
  scope: "active-team" | "caller-in-active-team" | "platform-public" | "platform-admin";
  population: string; coverageFrom: string | null;

  /* The four times and the hit. `asOf` says when the figures were COMPUTED and a cache hit keeps it;
   * `observedAt` says when THIS request obtained its answer and is new on every request; `builtAt` and
   * `sourceRevision` describe persisted derived data and are null for an answer computed from rows;
   * `cacheHit` is the cache's own decision, which no caller may infer by comparing the first two.
   *
   * TRANSITIONAL: optional here, and Phase 2 is what makes them required. It cannot be this phase.
   * `read-envelope.ts` stamps them onto an answer AFTER the route has built it, and a middleware cannot
   * make an object literal satisfy a required field: the routes that build a `meta` without the five
   * would stop compiling before anything filled them, and every fixture in the console's own repository
   * would stop typechecking with them. Until Phase 2 tightens both declarations together, a caller that
   * needs one handles `undefined` as "this route has not been migrated", never as a value. */
  observedAt?: string;
  revision?: string | null;
  builtAt?: string | null;
  sourceRevision?: string | null;
  cacheHit?: boolean;
};
export type Part<T> = { state: "ok"; data: T } | { state: "unavailable"; reason: string };
export type MeasureKey = "malformed_per_1000" | "same_tool_followup_pct" | "call_p50_ms" | "call_p95_ms"
  | "searches_with_results_pct" | "bugs_per_1000" | "sessions" | "work_finished";
export type Measure = {
  key: MeasureKey; weeks: PeriodFigure[];
  first: PeriodFigure | null; best: PeriodFigure | null;
  last: PeriodFigure | null; previous: PeriodFigure | null;
  highest: PeriodFigure | null; lowest: PeriodFigure | null;
  better: "up" | "down" | "neutral";
  judgement: "improved" | "worsened" | "unchanged" | "neutral" | "not_comparable";
  finding: Finding | null;
};

/** One week as a read counted it, oldest first. `value` is the read's own: a percentile as computed,
 *  otherwise `numerator / denominator` scaled. The four bounds are instants and pass through as given. */
type WeekCounts = {
  from: string; to: string; observedFrom: string | null; observedThrough: string | null;
  numerator: number | null; denominator: number | null; value: number | null;
  samples: number; complete: boolean; available: boolean;
};

/** What `summarise` needs of a measure: `minSamples` is 30 for a Platform rate or latency and 0 for an
 *  own-team figure; `precision` the decimals the page prints; `definedFrom` and `coverageFrom` local
 *  dates (`YYYY-MM-DD`) in `timezone`; `label` and `countLabel` the words a finding uses. */
export type MeasureInput = {
  key: MeasureKey; better: Measure["better"]; minSamples: number; precision: number;
  definedFrom: string | null; label: string; countLabel: string | null; coverageFrom: string;
  timezone: string; weeks: WeekCounts[];
};

/** Whether a week began, on the reporting timezone's calendar, before a local date. en-CA formats as
 *  YYYY-MM-DD, so the two compare as strings. */
const startsBefore = (instant: string, date: string, timezone: string): boolean =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(instant)) < date;

/** Weeks of counts as the measure the page draws. Values are compared at the printed precision, a tie
 *  keeps the earliest week, and only complete weeks are ever named: a running week is drawn, never chosen.
 *  A record, best or highest or lowest, is only ever a week whose figure stands: an insufficient one is
 *  drawn with its value and holds none. */
export function summarise(input: MeasureInput): Measure {
  const at = (v: number): number => Math.round(v * 10 ** input.precision);
  const weeks = input.weeks.map((w): PeriodFigure => {
    const window = { from: w.from, to: w.to, observedFrom: w.observedFrom, observedThrough: w.observedThrough, complete: w.complete };
    // Before its definition began, a week was not counted this way at all.
    if (!w.available || (input.definedFrom !== null && startsBefore(w.from, input.definedFrom, input.timezone))) {
      return { window, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null };
    }
    const figure: Figure = w.denominator === 0 || w.value === null
      ? { value: null, why: "no_data" }
      : { value: w.value, why: w.samples < input.minSamples ? "insufficient" : null };
    return { window, figure, numerator: w.numerator, denominator: w.denominator };
  });

  const whole = weeks.filter((w) => w.window.complete);
  const stands = whole.filter((w) => w.figure.why === null);
  // The first week strictly ahead in `ahead`'s order wins, so a tie keeps the earliest.
  const pick = (from: PeriodFigure[], ahead: (a: number, b: number) => boolean): PeriodFigure | null =>
    from.reduce<PeriodFigure | null>((b, w) => (b === null || ahead(at(w.figure.value!), at(b.figure.value!)) ? w : b), null);
  const below = (a: number, b: number): boolean => a < b;
  const above = (a: number, b: number): boolean => a > b;
  const neutral = input.better === "neutral";

  const last = whole.at(-1) ?? null;
  const previous = whole.at(-2) ?? null;
  let judgement: Measure["judgement"];
  if (neutral) judgement = "neutral";
  else if (!last || !previous || last.figure.why !== null || previous.figure.why !== null) judgement = "not_comparable";
  else {
    const a = at(last.figure.value!), b = at(previous.figure.value!);
    judgement = a === b ? "unchanged" : (a < b) === (input.better === "down") ? "improved" : "worsened";
  }

  const measure: Measure = {
    key: input.key, weeks,
    first: stands[0] ?? null,
    best: neutral ? null : pick(stands, input.better === "down" ? below : above),
    last, previous,
    highest: neutral ? pick(stands, above) : null,
    lowest: neutral ? pick(stands, below) : null,
    better: input.better, judgement, finding: null,
  };
  measure.finding = weekFinding(measure, input);
  return measure;
}
