/**
 * The calendar Work's prepared queries read a window's dates and buckets on: the reporting timezone's days, as
 * every Work page reads them.
 *
 * A date names the whole of that local day, so a window of dates runs from the first date's midnight up to the
 * midnight after the last. A bucket is a run of local days: a day keyed by its date, a week by its Monday's date,
 * a month by its year and month, and a weekday by its English name, the keys ZZ Meridian's aggregate names its
 * buckets by. A window's buckets are every one it touches before its end or the cutoff, whichever is earlier, so
 * an empty one is still answered.
 *
 * DELIBERATE: no backticks in the comments of this file, as work-query.ts says.
 */
import { ZZ_TZ } from "./shared.js";

export const BUCKETS = ["day", "week", "month", "weekday"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: ZZ_TZ });
const CLOCK_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZZ_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** The local date an instant falls on, YYYY-MM-DD. */
export const localDay = (ms: number): string => DAY_FMT.format(new Date(ms));

/** Whether a text is a calendar date, YYYY-MM-DD, that the calendar has. */
export function isDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text;
}

/** The date a number of days after another, on the calendar alone. */
export const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The instant a local date begins in the reporting timezone. */
export function midnight(date: string): number {
  const offset = (ms: number): number => {
    const p = CLOCK_FMT.formatToParts(new Date(ms));
    const n = (t: string): number => Number(p.find((x) => x.type === t)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
  };
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - offset(guess - offset(guess));
}

/** A date's weekday, Monday first. */
const weekdayOf = (date: string): string => WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];

/** The key of the bucket a local date falls in. */
function keyOfDate(bucket: Bucket, date: string): string {
  if (bucket === "day") return date;
  if (bucket === "month") return date.slice(0, 7);
  if (bucket === "weekday") return weekdayOf(date);
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

/** The first of the month after a date's, written out rather than through Date.UTC, which reads a year below 100 as 1900 on. */
function nextMonth(date: string): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return m === 12 ? `${String(y + 1).padStart(4, "0")}-01-01` : `${date.slice(0, 4)}-${String(m + 1).padStart(2, "0")}-01`;
}

/** The key of the bucket an instant falls in. */
export const bucketOf = (bucket: Bucket, ms: number): string => keyOfDate(bucket, localDay(ms));

/** Every bucket from one instant up to another, oldest first; a weekday's Monday to Sunday, those the span holds. */
export function bucketsOf(bucket: Bucket, fromMs: number, endMs: number): string[] {
  if (endMs <= fromMs) return [];
  const first = localDay(fromMs), last = localDay(endMs - 1);
  if (bucket === "weekday") {
    const held = new Set<string>();
    for (let d = first; d <= last && held.size < 7; d = addDays(d, 1)) held.add(weekdayOf(d));
    return WEEKDAYS.filter((w) => held.has(w));
  }
  const keys: string[] = [];
  let d = bucket === "month" ? `${first.slice(0, 7)}-01` : keyOfDate(bucket, first);
  while (d <= last) {
    keys.push(keyOfDate(bucket, d));
    d = bucket === "day" ? addDays(d, 1) : bucket === "week" ? addDays(d, 7) : nextMonth(d);
  }
  return keys;
}

/** How a bucket is named. */
export function bucketLabel(bucket: Bucket, key: string): string {
  if (bucket === "week") return `Week from ${key}`;
  if (bucket === "month") return `Month ${key}`;
  return key;
}
