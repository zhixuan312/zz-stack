/**
 * The initiatives and searches the Initiatives list and Work's shared figures are read from, and what
 * they must answer over them: `checks/console-work-initiatives.ts` makes the initiatives through a real
 * zz-core with the steps below, then moves each one's timestamps into the week the seed names, and
 * writes the searches directly, as zz-core's `knowledge.search` rows.
 *
 * Every instant is a week and an hour of it, `[back, hours]`: `hours` into the reporting timezone's
 * week `back` weeks before the running one. The timezone is Asia/Singapore, eight hours ahead of UTC
 * with no daylight saving, so a week cut on UTC's calendar would move what lies before local 08:00 on
 * a Monday. Nothing is placed in the running week, so the expected values do not depend on the day the
 * check runs.
 *
 * Thirteen initiatives in the seeded team, four of them under sdlc-flow, whose gated documents are
 * spec.md, plan.md and review.md (the handover left out):
 *
 *   w-spec          sdlc-flow, spec.md written and presented, not approved   waiting   0 of 3
 *   g-plan          sdlc-flow, spec.md approved                              open      1 of 3
 *   q-quiet         sdlc-flow, explore.md written, four weeks ago            quiet     0 of 3
 *   o-fresh         no flow, notes.md written last week                      open
 *   o-empty         no flow, no document, opened last week                   open
 *   q-empty         no flow, no document, opened five weeks ago              quiet
 *   search-ranking  no flow, no document, opened last week                   open
 *   acc-one         no flow, closed finished on notes.md                     accepted
 *   acc-two         no flow, closed finished on notes.md                     accepted
 *   search-cache    no flow, closed finished with a reason for no sign-off   delivered
 *   del-two         no flow, closed finished with a reason for no sign-off   delivered
 *   ab-empty        no flow, no document, abandoned                          abandoned
 *   ab-doc          sdlc-flow, explore.md written, abandoned on it           abandoned
 *
 * and one in a second team, which no read of the first may show.
 *
 * Searches, zz-core's `knowledge.search` rows of the seeded team: last week three completed, two of
 * them returning something; the week before one completed returning nothing. Beside them, none
 * counted: a maintenance search, a search that recorded no `detail.returned`, and the second team's.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type { OUTCOMES } from "@zz/contracts";
import type pg from "pg";

export const TIMEZONE = "Asia/Singapore";
const OFFSET_MS = 8 * 3_600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** The second team, and the person who acts for it. */
export const OTHER_TEAM = "work-other";
export const OTHER_EMAIL = "other@example.test";

/** A week before the running one and the hours into it. */
export type When = [back: number, hours: number];
export type State = "open" | "waiting" | "quiet" | (typeof OUTCOMES)[number];

/** One initiative: what is made of it, and where it is moved. A closed one is moved so it opened and
 *  closed at the instants named; an open one so its newest write, or its opening with none, lands on
 *  `touched`. */
export interface Made {
  key: string; flow: "sdlc-flow" | null;
  docs: "none" | "notes" | "explore" | "spec-presented" | "spec-signed";
  close?: (typeof OUTCOMES)[number];
  opened?: When; closed?: When; touched?: When;
  /** What the list must read of it. */
  state: State; gates: [passed: number, of: number];
}

export const MADE: readonly Made[] = [
  { key: "w-spec", flow: "sdlc-flow", docs: "spec-presented", touched: [1, 30], state: "waiting", gates: [0, 3] },
  { key: "g-plan", flow: "sdlc-flow", docs: "spec-signed", touched: [1, 50], state: "open", gates: [1, 3] },
  { key: "q-quiet", flow: "sdlc-flow", docs: "explore", touched: [4, 20], state: "quiet", gates: [0, 3] },
  { key: "o-fresh", flow: null, docs: "notes", touched: [1, 70], state: "open", gates: [0, 0] },
  { key: "o-empty", flow: null, docs: "none", touched: [1, 90], state: "open", gates: [0, 0] },
  { key: "q-empty", flow: null, docs: "none", touched: [5, 10], state: "quiet", gates: [0, 0] },
  { key: "search-ranking", flow: null, docs: "none", touched: [1, 100], state: "open", gates: [0, 0] },
  { key: "acc-one", flow: null, docs: "notes", close: "accepted", opened: [3, 10], closed: [2, 34], state: "accepted", gates: [0, 0] },
  { key: "acc-two", flow: null, docs: "notes", close: "accepted", opened: [2, 10], closed: [2, 20], state: "accepted", gates: [0, 0] },
  { key: "search-cache", flow: null, docs: "notes", close: "delivered", opened: [2, 0], closed: [1, 40], state: "delivered", gates: [0, 0] },
  { key: "del-two", flow: null, docs: "notes", close: "delivered", opened: [1, 0], closed: [1, 12], state: "delivered", gates: [0, 0] },
  { key: "ab-empty", flow: null, docs: "none", close: "abandoned", opened: [3, 50], closed: [1, 60], state: "abandoned", gates: [0, 0] },
  { key: "ab-doc", flow: "sdlc-flow", docs: "explore", close: "abandoned", opened: [6, 0], closed: [6, 24], state: "abandoned", gates: [0, 3] },
];

/** When each one was last touched: its close when the close wrote its document, its opening when it
 *  holds none, and otherwise where it was moved to. */
export const touchedOf = (m: Made): When => m.touched ?? (m.docs === "none" ? m.opened! : m.closed!);

/** The list's order: waiting first, then the most recently touched. */
export const ORDER = ["w-spec", "search-ranking", "o-empty", "o-fresh", "g-plan", "search-cache", "del-two", "acc-one",
  "acc-two", "ab-empty", "q-quiet", "q-empty", "ab-doc"] as const;

/** What the reads must answer over the seed, the weeks counted back from the running one. */
export const EXPECTED = {
  tiles: { open: 7, waiting: 1, closed: { accepted: 2, delivered: 2, abandoned: 2 } },
  /** The first initiative opened at the start of the sixth week back, so the record is seven weeks. */
  weeks: 7,
  /** Closures by week back: `[accepted, delivered, abandoned]`; every other week none. */
  closures: { 6: [0, 0, 1], 2: [2, 0, 0], 1: [0, 2, 1] } as Record<number, [number, number, number]>,
  /** How many rows were last touched in each week back, of all thirteen. */
  touched: { 6: 1, 5: 1, 4: 1, 3: 1, 2: 2, 1: 7 } as Record<number, number>,
  byState: { open: 4, waiting: 1, quiet: 2, accepted: 2, delivered: 2, abandoned: 2 },
  byFlow: [{ flow: null, count: 9 }, { flow: "sdlc-flow", count: 4 }],
  /** Median hours from opened to closed, by the week back of the close, `[median, closures]`. */
  toClose: { 6: [24, 1], 2: [101, 2], 1: [208, 3] } as Record<number, [number, number]>,
  toCloseOverall: [108, 6],
  toAbandon: { 6: [24, 1], 1: [346, 1] } as Record<number, [number, number]>,
  toAbandonOverall: [185, 2],
  /** The most open at once over the whole record, and when it was first reached. */
  mostOpen: { value: 7, at: [1, 100] as When },
  /** The same over the third week back alone: two carried in, then two opened in it. */
  mostOpenThird: { value: 4, at: [3, 50] as When },
  /** Opened in the second week back, earliest first. */
  openedSecond: ["search-cache", "acc-two"],
  /** Searches with results by week back, `[found, completed]`; every other week none completed. */
  searches: { 2: [0, 1], 1: [2, 3] } as Record<number, [number, number]>,
} as const;

/** The first instant of the running week, Monday 00:00 in the reporting timezone, at `nowMs`. */
export function runningWeek(nowMs: number): number {
  const day = Math.floor((nowMs + OFFSET_MS) / DAY);
  const monday = day - ((day + 3) % 7);  // 1 January 1970 was a Thursday
  return monday * DAY - OFFSET_MS;
}

/** The instant `hours` into the week `back` weeks before the one starting at `w0`. */
export const at = (w0: number, [back, hours]: When): number => w0 - back * WEEK + hours * HOUR;

/** Moves every timestamp of one initiative: the initiative's own, its documents' and revisions', and its
 *  events'. Each move is from one instant to another, so it is exact to the microsecond. A row at or
 *  after the late move's first instant moves by the late move, every other by the early one. */
async function shift(sql: pg.Client, id: string, early: [to: string, from: string], late: [to: string, from: string] | null): Promise<void> {
  const args = [id, early[0], early[1], late?.[0] ?? null, late?.[1] ?? null];
  await sql.query(
    `update zz.initiative
        set opened_at = opened_at + case when $5::timestamptz is not null and opened_at >= $5::timestamptz
                                         then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end,
            closed_at = closed_at + case when $5::timestamptz is not null and closed_at >= $5::timestamptz
                                         then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end
      where id = $1::uuid`, args);
  await sql.query(
    `update zz.doc_revision r
        set written_at = written_at + case when $5::timestamptz is not null and written_at >= $5::timestamptz
                                           then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end,
            presented_at = presented_at + case when $5::timestamptz is not null and presented_at >= $5::timestamptz
                                               then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end,
            approved_at = approved_at + case when $5::timestamptz is not null and approved_at >= $5::timestamptz
                                             then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end
       from zz.doc d
      where r.doc_id = d.id and d.initiative_id = $1::uuid`, args);
  await sql.query(
    `update zz.doc
        set created_at = created_at + case when $5::timestamptz is not null and created_at >= $5::timestamptz
                                           then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end,
            updated_at = updated_at + case when $5::timestamptz is not null and updated_at >= $5::timestamptz
                                           then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end
      where initiative_id = $1::uuid`, args);
  await sql.query(
    `update zz.event
        set ts = ts + case when $5::timestamptz is not null and ts >= $5::timestamptz
                           then $4::timestamptz - $5::timestamptz else $2::timestamptz - $3::timestamptz end
      where initiative_id = $1::uuid`, args);
}

/** Moves the initiative `slug` as `m` says, the running week starting at `w0`: a closed one so it
 *  opened at `m.opened` and its close, with everything the close wrote, at `m.closed`; an open one so
 *  its newest revision write, or its opening with none, is at `m.touched`. */
export async function place(sql: pg.Client, slug: string, m: Made, w0: number): Promise<void> {
  const { rows: [row] } = await sql.query<{ id: string; opened: string; closed: string | null; written: string | null }>(
    `select i.id::text as id, i.opened_at::text as opened, i.closed_at::text as closed,
            (select max(r.written_at)::text from zz.doc d join zz.doc_revision r on r.doc_id = d.id
              where d.initiative_id = i.id) as written
       from zz.initiative i where i.slug = $1`, [slug]);
  const to = (w: When): string => new Date(at(w0, w)).toISOString();
  if (m.close) await shift(sql, row.id, [to(m.opened!), row.opened], [to(m.closed!), row.closed!]);
  else await shift(sql, row.id, [to(m.touched!), row.written ?? row.opened], null);
}

/** zz-core's searches, written as its own rows: last week three completed for the seeded team, two
 *  finding something, the week before one finding nothing, and beside them a maintenance search, a
 *  search with no result set recorded, and one of the second team's, none of which the team's figure
 *  counts. */
export async function seedSearches(sql: pg.Client, team: string, other: string, w0: number): Promise<void> {
  const found = { returned: [{ kind: "lesson", id: "seeded" }] };
  const none = { returned: [] };
  const rows: [When, string, string, object][] = [
    [[1, 10], team, "work", found], [[1, 11], team, "work", found], [[1, 12], team, "work", none],
    [[2, 30], team, "work", none],
    [[1, 13], team, "platform", found], [[1, 14], team, "work", {}], [[1, 15], other, "work", found],
  ];
  await sql.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id)
     select u.ts, 'knowledge.search', 'seeded query', u.detail, u.origin, t.id
       from unnest($1::timestamptz[], $2::text[], $3::text[], $4::jsonb[]) as u(ts, team, origin, detail)
       join zz.team t on t.slug = u.team`,
    [rows.map((r) => new Date(at(w0, r[0])).toISOString()), rows.map((r) => r[1]), rows.map((r) => r[2]),
     rows.map((r) => JSON.stringify(r[3]))]);
}
