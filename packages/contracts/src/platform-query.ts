/**
 * The answer of the Platform prepared query, `GET /api/console/platform/query`: one measure of the platform, over a
 * window of the reporting time zone's whole days, grouped by one of its dimensions or by a bucket of its days, against
 * the window before when asked, and down to the rows its page draws. The shape is Work's prepared query's, with a
 * group's key null for the rows that have no value along the dimension, and the folded groups' previous value beside
 * their value.
 *
 * COUPLED: services/gateway/src/console/platform-query.ts answers it, and the console declares its own copy, since
 * the browser does not import this package.
 */

/** A number as a page states it: null with the reason it is not there. */
export type PlatformQueryFigure = {
  value: number | null;
  why: "no_data" | "insufficient" | "unavailable" | null;
};

/** The half-open interval of instants the window's days span, and how much of it was observed by the cutoff. */
type PlatformQueryWindow = {
  from: string; to: string;
  observedFrom: string | null; observedThrough: string | null;
  complete: boolean;
};

/** What the read was over, as every console read states it. */
type PlatformQueryMeta = {
  asOf: string; timezone: string;
  period: { from: string; to: string };
  scope: "platform-public" | "platform-admin";
  population: string; coverageFrom: string | null;
};

/** One group: its key along the dimension or bucket asked (null for the rows with none), its label, its value, its
 *  share of the total, and its value in the window before when that was asked. */
export type PlatformQueryGroup = {
  key: string | null; label: string;
  value: PlatformQueryFigure; share: number | null; previous: PlatformQueryFigure | null;
};

/** One drilled row: the row the measure's page draws, the instant it is ordered by, and its console address. */
type PlatformQueryRow = Record<string, unknown> & { at: string; address: string };

type PlatformQueryPart<T> = { state: "ok"; data: T } | { state: "unavailable"; reason: string };

export type PlatformQuery = {
  meta: PlatformQueryMeta;
  measure: string; by: string | null; window: PlatformQueryWindow;
  groups: PlatformQueryGroup[];
  /** The groups past `top`, or for a bucket the earlier buckets, folded into one count. */
  rest: { groups: number; value: number; previous: number | null } | null;
  total: PlatformQueryFigure;
  rows: PlatformQueryPart<{ rows: PlatformQueryRow[]; total: number }> | null;
};
