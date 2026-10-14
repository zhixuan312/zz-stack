/**
 * The events the platform's status is read from, seeded into a throwaway database, and the values a
 * reader must find beside them: `checks/console-platform-status.ts` drives the gateway's own route
 * over them, and the Phase 0 skeleton signs the same people in through a real gateway and reads the
 * same figure.
 *
 * Weeks are Monday to Monday in the reporting timezone, counted back from the running one: `back`
 * 0 is the running week, 1 the last whole week (L), 2 the one before it (L-1), and so on. Each
 * week's first instant is computed here from the timezone's own calendar (`Intl`), not by asking
 * Postgres, so a reader that cut weeks on the wrong calendar does not agree with this by sharing
 * its mistake.
 *
 * What it writes, `tool_call` events unless said otherwise:
 *
 *   - L: team one, 74 work calls of which 4 `ours`, 1 `theirs` and 5 `guardrail`, and one `ours`
 *     work call at exactly L's first instant; team two, 50 work calls of which 3 `ours`; 40
 *     maintenance (`platform`) calls of which 10 `ours`; one `console.page_view`;
 *   - L-1: 200 work calls of which 4 `ours`;
 *   - L-2: 12 work calls of which 3 `ours`, under the 30 a weekly rate stands on;
 *   - L-3: none;
 *   - L-4: 100 work calls of which 10 `ours`, the earliest at exactly L-4's first instant, so
 *     coverage begins on a week's boundary and every week from L-4 to L is wholly observed;
 *   - the running week: one `ours` work call at exactly its first instant, which is the first
 *     instant after L, and 4 work calls none of them refused.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import { createHash, randomBytes } from "node:crypto";

import type pg from "pg";

/** The team the member is admin of, and a second team whose slug no answer to that member may hold. */
const TEAM_ONE = "kestrel-works";
export const TEAM_TWO = "heron-works";

/** The three people a reader signs in as: team one's admin, a superadmin in no team, and a member
 *  in no team. */
export const MEMBER = "member@status.example.test";
export const SUPERADMIN = "superadmin@status.example.test";
export const NO_TEAM = "loner@status.example.test";

type Owner = "ours" | "theirs" | "guardrail";

/** One run of seeded tool calls: `back` weeks before the running one, `offsetMs` after that
 *  week's first instant for the first call and one second apart after it. The first `ours` calls
 *  are refused as malformed, the next `theirs` as tool failures, the next `guardrail` as the
 *  platform doing its job; the rest succeed. */
interface Calls {
  back: number; team: "one" | "two"; origin: "work" | "platform";
  calls: number; ours: number; theirs?: number; guardrail?: number;
  offsetMs: number;
}

export const CALLS: readonly Calls[] = [
  { back: 5, team: "one", origin: "work", calls: 100, ours: 10, offsetMs: 0 },
  { back: 3, team: "one", origin: "work", calls: 12, ours: 3, offsetMs: 60_000 },
  { back: 2, team: "one", origin: "work", calls: 200, ours: 4, offsetMs: 60_000 },
  { back: 1, team: "one", origin: "work", calls: 1, ours: 1, offsetMs: 0 },
  { back: 1, team: "one", origin: "work", calls: 74, ours: 4, theirs: 1, guardrail: 5, offsetMs: 60_000 },
  { back: 1, team: "two", origin: "work", calls: 50, ours: 3, offsetMs: 60_000 },
  { back: 1, team: "one", origin: "platform", calls: 40, ours: 10, offsetMs: 60_000 },
  { back: 0, team: "one", origin: "work", calls: 1, ours: 1, offsetMs: 0 },
  { back: 0, team: "one", origin: "work", calls: 4, ours: 0, offsetMs: 1_000 },
];

/** The one event of another kind, in L, an hour into it. */
const PAGE_VIEW = { back: 1, offsetMs: 3_600_000, kind: "console.page_view", subject: "platform.status" } as const;

/** A week as the route must answer it, `back` weeks before the running one. */
interface ExpectedWeek {
  back: number; numerator: number; denominator: number;
  value: number | null; why: "no_data" | "insufficient" | null; complete: boolean;
}

/** What a reader must find, written out by hand from the list above and not computed from it, oldest
 *  week first. The running week's counts depend on the moment it is read, so only its `complete` is
 *  stated. */
export const EXPECTED = {
  weeks: [
    { back: 5, numerator: 10, denominator: 100, value: 100, why: null, complete: true },
    { back: 4, numerator: 0, denominator: 0, value: null, why: "no_data", complete: true },
    { back: 3, numerator: 3, denominator: 12, value: 250, why: "insufficient", complete: true },
    { back: 2, numerator: 4, denominator: 200, value: 20, why: null, complete: true },
    { back: 1, numerator: 8, denominator: 125, value: 64, why: null, complete: true },
  ] as readonly ExpectedWeek[],
  running: { back: 0, complete: false },
  /** By `back`. */
  first: 5, best: 2, last: 1, previous: 2,
  highest: null, lowest: null,
  judgement: "worsened",
} as const;

/** The local wall clock at `ms` in `timezone`, and the weekday, Monday 0. */
function wall(ms: number, timezone: string): { y: number; m: number; d: number; h: number; mi: number; s: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const at = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(at("year")), m: Number(at("month")), d: Number(at("day")),
    h: Number(at("hour")), mi: Number(at("minute")), s: Number(at("second")),
    dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(at("weekday")),
  };
}

/** How far `timezone`'s wall clock is ahead of UTC at `ms`. */
function offsetAt(ms: number, timezone: string): number {
  const w = wall(ms, timezone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local calendar date's midnight falls on. Twice, so a midnight a daylight-saving
 *  change lies between UTC's and the zone's reads the offset on its own side of the change. */
function localMidnight(y: number, m: number, d: number, timezone: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const once = guess - offsetAt(guess, timezone);
  return guess - offsetAt(once, timezone);
}

/** The first instant of the week `back` weeks before the one `now` falls in, Monday 00:00 local. */
export function weekStart(now: number, back: number, timezone: string): number {
  const w = wall(now, timezone);
  // Calendar arithmetic on the date alone, in UTC where no day is longer than another.
  const monday = new Date(Date.UTC(w.y, w.m - 1, w.d - w.dow - 7 * back));
  return localMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), timezone);
}

/** What `seedStatus` wrote: each week's first instant by `back`, the moment it read the clock, and
 *  the timezone it cut weeks in. */
export interface Seeded { now: number; timezone: string; starts: Map<number, number> }

/**
 * Seeds the two teams, the three people and every event above into `db`, cutting weeks in
 * `timezone` — the reporting timezone of the gateway that will read them (`ZZ_TZ`).
 *
 * The database must hold no other `tool_call`: the route counts every real-work call there is.
 */
export async function seedStatus(db: pg.ClientBase | pg.Pool, timezone: string, now = Date.now()): Promise<Seeded> {
  const person = async (email: string, role: "member" | "superadmin"): Promise<string> => (await db.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, $3) returning id", [email, email.split("@")[0], role])).rows[0].id;
  const member = await person(MEMBER, "member");
  const superadmin = await person(SUPERADMIN, "superadmin");
  await person(NO_TEAM, "member");
  const team = async (slug: string, by: string): Promise<string> => (await db.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, by])).rows[0].id;
  const one = await team(TEAM_ONE, member);
  const two = await team(TEAM_TWO, superadmin);
  await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $2)", [one, member]);
  await db.query("update zz.principal set active_team_id = $1 where id = $2", [one, member]);

  const starts = new Map<number, number>();
  for (let back = 0; back <= 5; back++) starts.set(back, weekStart(now, back, timezone));

  for (const c of CALLS) {
    const from = starts.get(c.back)! + c.offsetMs;
    const ts = Array.from({ length: c.calls }, (_, i) => new Date(from + i * 1000).toISOString());
    const owners: (Owner | null)[] = [
      ...Array<Owner>(c.ours).fill("ours"), ...Array<Owner>(c.theirs ?? 0).fill("theirs"),
      ...Array<Owner>(c.guardrail ?? 0).fill("guardrail"),
    ];
    while (owners.length < c.calls) owners.push(null);
    await db.query(
      `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id)
       select u.ts, 'tool_call', 'core:knowledge_search', u.owner is null, 'core:knowledge_search', u.owner,
              case when u.owner is null then null else 'seeded refusal' end, $3, $4, $5
         from unnest($1::timestamptz[], $2::text[]) as u(ts, owner)`,
      [ts, owners, c.origin, c.team === "one" ? one : two, member]);
  }
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
     values ($1, $2, $3, '{"workspace":"platform"}'::jsonb, 'work', $4, $5)`,
    [new Date(starts.get(PAGE_VIEW.back)! + PAGE_VIEW.offsetMs).toISOString(), PAGE_VIEW.kind, PAGE_VIEW.subject, one, member]);
  return { now, timezone, starts };
}

/** Signs `email` in as a browser would be: a live console session row, and the secret its
 *  `zz_console` cookie carries. */
export async function signIn(db: pg.ClientBase | pg.Pool, email: string): Promise<string> {
  const secret = randomBytes(24).toString("hex");
  await db.query(
    `insert into zz.console_session (principal_id, token_hash, expires_at)
     select id, $2, now() + interval '1 hour' from zz.principal where email = $1`,
    [email, createHash("sha256").update(secret, "utf8").digest("hex")]);
  return secret;
}
