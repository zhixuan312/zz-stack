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

/* ---- The eight measures and the reader's own team ----
 *
 * `seedMeasures` writes, on top of `seedStatus` and never in place of it (the Bugs check and the skeleton
 * count `seedStatus`'s calls as they are), everything the measures beyond the malformed-call rate are read
 * from; `seedNoise` writes what none of them may count. `MEASURES` is what a reader must find once both
 * have run, written out by hand from the lists below, L-4 (back 5) to L (back 1), oldest first.
 *
 * Every call `seedStatus` wrote has no session, no duration and the tool `core:knowledge_search`, so its
 * refusals are refused searches with no session. On top of it, in team one unless said otherwise:
 *
 *   - in L-4, L-2, L-1 and L, refusals (`guardrail`) of `core:document_read` ten minutes apart, the first
 *     `followed` of them put right 30 seconds later in the same session, and `extra` successes of
 *     `core:skill_read`; every one of these calls is timed, 10, 20, 30 ... ms, so a week's median and 95th
 *     percentile each fall on one call;
 *   - in L, AC-2.14's follow-up cases, one session each: a refusal put right 119, 120 and 121 seconds later
 *     (a success counts strictly within 120 seconds, so only the first); one with no session; one followed
 *     only in team two, only in another session, only by another tool, and only in another initiative; one
 *     with no initiative followed in one; three refusals before one success; one never followed; one a
 *     minute before L ends put right 30 seconds into the running week, counted in L; one of team two's put
 *     right in team two, which no figure of team one's counts; and a batched call,
 *     whose duration no percentile reads. In the running week, a refusal 5 seconds before the seed's clock
 *     and its success, read within its 120 seconds and so within the lookahead;
 *   - zz-core's `knowledge.search` rows: three without `detail.returned` in L-3; the first with it on
 *     L-2's Wednesday, so L-2 is not yet defined; the first with `detail.broadened` at 01:00 on L-1's
 *     Monday, so L-1 is;
 *   - bug reports: team one's fixed in L-4, open and not-a-bug in L-1, a duplicate in L, team two's open in
 *     L, and a release check's own in L;
 *   - closes: the first abandoned on L-2's Thursday, so L-2 is not yet defined; accepted, delivered
 *     (team two) and abandoned in L-1; accepted in L; delivered in the running week.
 *
 * `seedNoise` writes, at noon on every day from L-4 through the running week's past, a maintenance call
 * refused and one that works (`origin = 'platform'`), a page view and a `knowledge.add` carrying a session,
 * and a maintenance search; a maintenance call the day before the record begins; and a maintenance
 * success 10 seconds after the refusal never followed, in its session.
 */
const DAY = 86_400_000;
const READ = "core:document_read", WRITE = "core:document_write", SKILL = "core:skill_read";

/** The follow-up case never put right: ten minutes per case into L's Wednesday. */
const NEVER_FOLLOWED = 11;

/** One call beyond `seedStatus`'s. */
interface Call {
  ts: number; team: "one" | "two"; origin: "work" | "platform"; owner: Owner | null; session: string; tool: string;
  initiative: "i1" | "i2" | null; durationMs: number | null; batched: boolean;
}

const BULK = [
  { back: 5, refusals: 40, followed: 20, extra: 1, sessions: 4 },
  { back: 3, refusals: 5, followed: 5, extra: 1, sessions: 2 },
  { back: 2, refusals: 40, followed: 30, extra: 11, sessions: 5 },
  { back: 1, refusals: 30, followed: 20, extra: 11, sessions: 3 },
];

/** `day` days and `seconds` seconds after the first instant of the week `back` weeks before the running one. */
const at = (s: Seeded, back: number, day: number, seconds: number): number => s.starts.get(back)! + day * DAY + seconds * 1000;

/** Every work call `seedMeasures` writes, by instant, the last two moments before `now`. */
function measureCalls(s: Seeded, now: number): Call[] {
  const call = (ts: number, session: string, over: Partial<Call> = {}): Call =>
    ({ ts, team: "one", origin: "work", owner: null, session, tool: READ, initiative: null, durationMs: null, batched: false, ...over });
  const refused = (ts: number, session: string, over: Partial<Call> = {}): Call => call(ts, session, { owner: "guardrail", ...over });
  const out: Call[] = [];
  for (const b of BULK) {
    const bulk: Call[] = [];
    for (let k = 0; k < b.refusals; k++) {
      const t = at(s, b.back, 1, k * 600), session = `b${b.back}-s${k % b.sessions}`;
      bulk.push(refused(t, session));
      if (k < b.followed) bulk.push(call(t + 30_000, session));
    }
    for (let j = 0; j < b.extra; j++) bulk.push(call(at(s, b.back, 1, 43_200 + j * 60), `b${b.back}-x`, { tool: SKILL }));
    bulk.forEach((c, i) => { c.durationMs = (i + 1) * 10; });
    out.push(...bulk);
  }
  const edge = (n: number): number => at(s, 1, 2, n * 600);
  out.push(
    refused(edge(1), "e1"), call(edge(1) + 119_000, "e1"),
    refused(edge(2), "e2"), call(edge(2) + 120_000, "e2"),
    refused(edge(3), "e3"), call(edge(3) + 121_000, "e3"),
    refused(edge(4), ""), call(edge(4) + 10_000, ""),
    refused(edge(5), "e5"), call(edge(5) + 10_000, "e5", { team: "two" }),
    refused(edge(6), "e6"), call(edge(6) + 10_000, "e6-other"),
    refused(edge(7), "e7"), call(edge(7) + 10_000, "e7", { tool: WRITE }),
    refused(edge(8), "e8", { initiative: "i1" }), call(edge(8) + 10_000, "e8", { initiative: "i2" }),
    refused(edge(9), "e9"), call(edge(9) + 10_000, "e9", { initiative: "i1" }),
    refused(edge(10), "e10"), refused(edge(10) + 5_000, "e10"), refused(edge(10) + 10_000, "e10"), call(edge(10) + 20_000, "e10"),
    refused(edge(NEVER_FOLLOWED), `e${NEVER_FOLLOWED}`),
    call(edge(12), "eb", { tool: SKILL, durationMs: 5_000, batched: true }),
    refused(edge(13), "e13", { team: "two" }), call(edge(13) + 10_000, "e13", { team: "two" }),
    refused(at(s, 0, 0, -60), "e12"), call(at(s, 0, 0, 30), "e12"),
    refused(now - 5_000, "e-late"), call(now - 3_000, "e-late"),
  );
  return out;
}

/** Writes calls as `seedStatus` writes its own, with their sessions, initiatives and durations. `ids` names
 *  the teams `one` and `two`, the initiatives `i1` and `i2` where a call names one, and the `member` who acts. */
async function insertCalls(db: pg.ClientBase | pg.Pool, calls: Call[], ids: Record<string, string>): Promise<void> {
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id, session,
                           initiative_id, duration_ms, batched)
     select u.ts, 'tool_call', u.tool, u.owner is null, u.tool, u.owner,
            case when u.owner is null then null else 'seeded refusal' end, u.origin, u.team, $10, u.session,
            u.initiative_id, u.duration, u.batched
       from unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::uuid[], $6::text[], $7::uuid[], $8::int[], $9::bool[])
            as u(ts, tool, owner, origin, team, session, initiative_id, duration, batched)`,
    [calls.map((c) => new Date(c.ts).toISOString()), calls.map((c) => c.tool), calls.map((c) => c.owner), calls.map((c) => c.origin),
     calls.map((c) => ids[c.team]), calls.map((c) => c.session), calls.map((c) => (c.initiative ? ids[c.initiative] : null)),
     calls.map((c) => c.durationMs), calls.map((c) => c.batched), ids.member]);
}

/** Writes zz-core's searches: each `[ts, team, detail]`, with a work or platform origin. */
async function insertSearches(db: pg.ClientBase | pg.Pool, rows: [number, string, object][], origin: string, member: string): Promise<void> {
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
     select u.ts, 'knowledge.search', 'seeded query', u.detail, $4, u.team, $5
       from unnest($1::timestamptz[], $2::uuid[], $3::jsonb[]) as u(ts, team, detail)`,
    [rows.map((r) => new Date(r[0]).toISOString()), rows.map((r) => r[1]), rows.map((r) => JSON.stringify(r[2])), origin, member]);
}

async function seededIds(db: pg.ClientBase | pg.Pool): Promise<{ member: string; one: string; two: string }> {
  return (await db.query<{ member: string; one: string; two: string }>(
    `select p.id::text as member, p.active_team_id::text as one, (select id::text from zz.team where slug = $2) as two
       from zz.principal p where p.email = $1`, [MEMBER, TEAM_TWO])).rows[0];
}

/** Seeds every row the eight measures read beyond `seedStatus`'s, and answers the work calls among them;
 *  `seedStatus` must have run on `db`. Read the measures within a minute of it: a refusal it writes 5
 *  seconds before `now` must still be inside its 120 seconds. */
export async function seedMeasures(db: pg.ClientBase | pg.Pool, s: Seeded, now = Date.now()): Promise<Call[]> {
  const { member, one, two } = await seededIds(db);
  const initiative = async (team: string, slug: string, closed: number | null, outcome: string | null): Promise<string> =>
    (await db.query<{ id: string }>(
      `insert into zz.initiative (team_id, slug, opened_at, closed_at, outcome, closed_by, accepted_by)
       values ($1, $2, coalesce($3::timestamptz - interval '1 day', now()), $3, $4, case when $3::timestamptz is null then null else $5::uuid end,
               case when $4 = 'accepted' then $5::uuid end)
       returning id`, [team, slug, closed === null ? null : new Date(closed).toISOString(), outcome, member])).rows[0].id;
  const i1 = await initiative(one, "2026-09-01-follow-up-one", null, null);
  const i2 = await initiative(one, "2026-09-01-follow-up-two", null, null);
  const calls = measureCalls(s, now);
  await insertCalls(db, calls, { one, two, i1, i2, member });

  const searches: [number, string, object][] = [];
  for (let i = 0; i < 3; i++) searches.push([at(s, 4, 2, i * 60), one, { ranked_total: 1 }]);
  const found = (yes: boolean): string[] => (yes ? ["team:kestrel-works:2026-09-01-follow-up-one/spec.md"] : []);
  for (let i = 0; i < 10; i++) searches.push([at(s, 3, 2, 3_600 + i * 60), one, { returned: found(i < 6), ranked_total: 1 }]);
  for (let i = 0; i < 40; i++) searches.push([at(s, 2, 0, 3_600 + i * 60), one, { returned: found(i < 30), broadened: i < 8 }]);
  for (let i = 0; i < 50; i++) searches.push([at(s, 1, 3, i * 60), i < 40 ? one : two, { returned: found(i < 45), broadened: i < 12 }]);
  await insertSearches(db, searches, "work", member);

  const report = async (back: number, hours: number, team: string, status: string, title: string, duplicateOf: string | null = null): Promise<string> => {
    const filed = at(s, back, 4, hours * 3_600);
    return (await db.query<{ id: string }>(
      `insert into zz.bug (reported_at, title, detail, platform_version, impact, status, resolution, resolved_at, team_id,
                           duplicate_of, reported_by, resolved_by)
       values ($1, $2, 'seeded', '0.99.0', 'confusing', $3, case when $3 = 'open' then null else 'seeded' end,
               case when $3 = 'open' then null else $1::timestamptz + interval '1 hour' end, $4, $5, $6,
               case when $3 = 'open' then null else $6::uuid end)
       returning id`, [new Date(filed).toISOString(), title, status, team, duplicateOf, member])).rows[0].id;
  };
  const fixed = await report(5, 0, one, "fixed", "seeded B1");
  await report(2, 0, one, "open", "seeded B2");
  await report(2, 1, one, "not_a_bug", "seeded B3");
  await report(1, 0, one, "duplicate", "seeded B4", fixed);
  await report(1, 1, two, "open", "seeded B5");
  await report(1, 2, one, "open", "chain-check probe 2026-09-30-chain-check-0930-a1b2c3");

  for (const [back, ms, team, outcome, slug] of [
    [3, 3 * DAY, one, "abandoned", "2026-09-02-first-close"], [2, 3 * DAY, one, "accepted", "2026-09-03-accepted"],
    [2, 3 * DAY + 3_600_000, two, "delivered", "2026-09-04-delivered"], [2, 3 * DAY + 7_200_000, one, "abandoned", "2026-09-05-abandoned"],
    [1, 3 * DAY, one, "accepted", "2026-09-06-accepted"], [0, 5_000, one, "delivered", "2026-09-07-delivered"],
  ] as const) await initiative(team, slug, s.starts.get(back)! + ms, outcome);
  return calls;
}

/** Seeds what no measure may count, on every day the rates are read; `seedMeasures` must have run on `db`. */
export async function seedNoise(db: pg.ClientBase | pg.Pool, s: Seeded): Promise<void> {
  const { member, one, two } = await seededIds(db);
  const calls: Call[] = [];
  const searches: [number, string, object][] = [];
  const noon: number[] = [];
  for (let back = 5; back >= 0; back--) for (let day = 0; day < 7; day++) if (at(s, back, day, 43_200) < s.now) noon.push(at(s, back, day, 43_200));
  const maintenance = (ts: number, session: string, owner: Owner | null): Call =>
    ({ ts, team: "one", origin: "platform", owner, session, tool: READ, initiative: null, durationMs: 99_999, batched: false });
  for (const t of noon) {
    calls.push(maintenance(t, "maint", "ours"), maintenance(t + 10_000, "maint", null));
    searches.push([t, one, { returned: [], broadened: true }]);
  }
  calls.push(maintenance(at(s, 5, -1, 0), "maint", null), maintenance(at(s, 1, 2, NEVER_FOLLOWED * 600 + 10), `e${NEVER_FOLLOWED}`, null));
  await insertCalls(db, calls, { one, two, member });
  await insertSearches(db, searches, "platform", member);
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id, session)
     select u.ts, u.kind, 'noise', '{}'::jsonb, 'work', $3, $4, 'noise'
       from unnest($1::timestamptz[], $2::text[]) as u(ts, kind)`,
    [noon.flatMap((t) => [new Date(t + 20_000).toISOString(), new Date(t + 30_000).toISOString()]),
     noon.flatMap(() => ["console.page_view", "knowledge.add"]), one, member]);
}

type Why = "no_data" | "insufficient" | "unavailable" | null;
/** A week as `[numerator, denominator, value, why]`. */
type Week = [number | null, number | null, number | null, Why];
/** A week before the measure was defined. */
const UNDEFINED: Week = [null, null, null, "unavailable"];

/** A measure as the route must answer it: its weeks L-4 to L, the weeks it names by `back`, and its finding, whose
 *  `{n}` is the local Monday of the week `back` n as a sentence prints it (`28 Sept`). */
interface ExpectedMeasure {
  key: string; better: "up" | "down" | "neutral"; weeks: Week[];
  first: number | null; best: number | null; last: number; previous: number; highest: number | null; lowest: number | null;
  judgement: string; finding: { kind: string; text: string } | null;
}

/** What a reader must find once `seedStatus`, `seedMeasures` and `seedNoise` have run, written out by hand. */
export const MEASURES = {
  measures: [
    { key: "malformed_per_1000", better: "down",
      weeks: [[10, 161, 10_000 / 161, null], [0, 0, null, "no_data"], [3, 23, 3_000 / 23, "insufficient"], [4, 281, 4_000 / 281, null], [8, 213, 8_000 / 213, null]],
      first: 5, best: 2, last: 1, previous: 2, highest: null, lowest: null, judgement: "worsened",
      finding: { kind: "count", text: "8 of 213 calls refused for their shape" } },
    { key: "same_tool_followup_pct", better: "up",
      weeks: [[20, 40, 50, null], [0, 0, null, "no_data"], [5, 5, 100, "insufficient"], [30, 40, 75, null], [27, 44, 2_700 / 44, null]],
      first: 5, best: 2, last: 1, previous: 2, highest: null, lowest: null, judgement: "worsened",
      finding: { kind: "count", text: "27 of 44 refusals followed by the same tool working within 2 minutes" } },
    { key: "call_p50_ms", better: "down",
      weeks: [[null, 61, 310, null], [null, 0, null, "no_data"], [null, 11, 60, "insufficient"], [null, 81, 410, null], [null, 61, 310, null]],
      first: 5, best: 5, last: 1, previous: 2, highest: null, lowest: null, judgement: "improved",
      finding: { kind: "best_week", text: "Lowest observed median call duration in a complete week, {1}, tied with {5}" } },
    { key: "call_p95_ms", better: "down",
      weeks: [[null, 61, 580, null], [null, 0, null, "no_data"], [null, 11, 105, "insufficient"], [null, 81, 770, null], [null, 61, 580, null]],
      first: 5, best: 5, last: 1, previous: 2, highest: null, lowest: null, judgement: "improved",
      finding: { kind: "best_week", text: "Lowest observed 95th percentile call duration in a complete week, {1}, tied with {5}" } },
    { key: "searches_with_results_pct", better: "up",
      weeks: [UNDEFINED, UNDEFINED, UNDEFINED, [30, 40, 75, null], [45, 50, 90, null]],
      first: 2, best: 1, last: 1, previous: 2, highest: null, lowest: null, judgement: "improved",
      finding: { kind: "incomplete", text: "Not enough complete weeks to compare yet" } },
    { key: "bugs_per_1000", better: "neutral",
      weeks: [[1, 161, 1_000 / 161, null], [0, 0, null, "no_data"], [0, 23, 0, "insufficient"], [2, 281, 2_000 / 281, null], [2, 213, 2_000 / 213, null]],
      first: 5, best: null, last: 1, previous: 2, highest: 1, lowest: 5, judgement: "neutral",
      finding: { kind: "high_week", text: "Most recorded bug reports per 1,000 calls in a week since {5}" } },
    { key: "sessions", better: "neutral",
      weeks: [[5, null, 5, null], [0, null, 0, null], [3, null, 3, null], [6, null, 6, null], [19, null, 19, null]],
      first: 5, best: null, last: 1, previous: 2, highest: 1, lowest: 4, judgement: "neutral",
      finding: { kind: "high_week", text: "Most recorded sessions in a week since {5}" } },
    { key: "work_finished", better: "neutral",
      weeks: [UNDEFINED, UNDEFINED, UNDEFINED, [2, null, 2, null], [1, null, 1, null]],
      first: 2, best: null, last: 1, previous: 2, highest: 2, lowest: 1, judgement: "neutral",
      finding: { kind: "incomplete", text: "Not enough complete weeks to compare yet" } },
  ] as ExpectedMeasure[],
  /** L-4 to L, then the running week: its one refusal with no session, and the one inside the lookahead. */
  followupCounts: [
    { refusals: 50, eligible: 40, missingSession: 10, withinLookahead: 0 }, { refusals: 0, eligible: 0, missingSession: 0, withinLookahead: 0 },
    { refusals: 8, eligible: 5, missingSession: 3, withinLookahead: 0 }, { refusals: 44, eligible: 40, missingSession: 4, withinLookahead: 0 },
    { refusals: 59, eligible: 44, missingSession: 15, withinLookahead: 0 }, { refusals: 2, eligible: 0, missingSession: 1, withinLookahead: 1 },
  ],
  missingDuration: [100, 0, 12, 200, 152],
  widened: [UNDEFINED, UNDEFINED, UNDEFINED, [8, 40, 20, null], [12, 50, 24, null]] as Week[],
  /** L-4 to L, then the running week. */
  failed: [10, 0, 3, 4, 14, 1],
  withoutSession: [100, 0, 12, 200, 127],
  /** Team one's, with no sample minimum. */
  own: {
    malformed: [[10, 161, 10_000 / 161, null], [0, 0, null, "no_data"], [3, 23, 3_000 / 23, null], [4, 281, 4_000 / 281, null], [5, 160, 5_000 / 160, null]] as Week[],
    followup: [[20, 40, 50, null], [0, 0, null, "no_data"], [5, 5, 100, null], [30, 40, 75, null], [26, 43, 2_600 / 43, null]] as Week[],
    sessions: [[5, null, 5, null], [0, null, 0, null], [3, null, 3, null], [6, null, 6, null], [17, null, 17, null]] as Week[],
    bugs: { filed: 4, fixed: 1, notABug: 1, duplicate: 1, open: 1 },
  },
};

/* ---- What needs attention, the doors and the records ----
 *
 * `seedNeeds` stands alone, on a database holding no other tool call, and `NEEDS` is what a reader must find over it,
 * written out by hand. Days are local in the timezone given, `D-k` the day `k` days before the seed's clock's own day,
 * every call one second after the last from local noon, and today's between local midnight and the clock. Weeks are
 * `weekStart`'s, `back` 0 the running one. Real-work tool calls, in team osprey unless said otherwise:
 *
 *   - the latency weeks: 30 `core:skill_read` calls from the first instant of back 6, 5 and 4, timed 100, 150 and
 *     300 ms, so the record begins on back 6's Monday and both latencies' last comparable week (back 4; the weeks
 *     after hold no duration) is at least twice its first;
 *   - `core`: 100 calls on each of D-19 to D-1, except D-10, whose 100 hold 1 tool failure (a fault day at exactly
 *     1%), and D-2, whose 50 hold 1 malformed call (no fault day); today 10, the first a tool failure;
 *   - `manage`: 50 calls on D-6, D-4, D-3 and D-1, 20 on D-5 with 1 tool failure (red, 5%), 50 on D-2 with 1 tool
 *     failure, the malformed call's day; today 20, the first a tool failure, after `core`'s;
 *   - `eval`: 10 calls on each of D-3 to D-1, one of D-1's refused as `other`; today 5;
 *   - bug reports: one real and open, blocking work, which the check resolves; one real and fixed; a release check's
 *     own probe, open;
 *   - evaluation findings: deferred for 20 and 15 days, the two waiting; deferred for 3 days; applied after 30;
 *     rejected after 30, superseded by the one 20 days old;
 *   - revisions of `sdlc-flow` documents waiting for approval (presented, current, gated, unapproved, open): plover's
 *     spec.md for 30 days, osprey's plan.md for 20 (its first revision approved), wren's spec.md for 18 and
 *     review.md for 16, lark's spec.md for 3; and none of these: finch's spec.md, approved; osprey's spec.md in a
 *     closed initiative; osprey's explore.md, which the flow does not gate; wren's plan.md, whose current revision
 *     was never presented; lark's spec.md in an initiative with no flow.
 */
export const NEEDS_SUPERADMIN = "superadmin@needs.example.test";
export const NEEDS_MEMBER = "member@needs.example.test";
/** Every team slug the seed writes; the first is the member's. */
export const NEEDS_TEAMS = ["osprey-works", "plover-works", "wren-works", "lark-works", "finch-works"] as const;

/** The first instant of the local day `back` days before the one `now` falls in. */
export function dayStart(now: number, back: number, timezone: string): number {
  const w = wall(now, timezone);
  const d = new Date(Date.UTC(w.y, w.m - 1, w.d - back));
  return localMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), timezone);
}

/** One run of calls: from `ts`, one second apart, through `tool`; the first `theirs` are tool failures, then the
 *  first `ours` malformed, then the first `other` classified as other; `durationMs` on every one, or none. */
type Run = { ts: number; tool: string; calls: number; theirs?: number; ours?: number; other?: number; durationMs?: number };

/** What a reader must find over `seedNeeds`, written out by hand. A day is `D-k` by its `k`, today `0`; `coverage`
 *  is the day the record begins, back 6's Monday. */
export const NEEDS = {
  doors: {
    core: { calls: 1_950, toolFailures: 2, others: 0, faultDays: 1, lastFaultDay: 10, run: { days: 9, atLeast: false, through: 1 },
            finding: { kind: "run", text: "9 days in a row under 1% tool failures, to {1}" }, today: "red" },
    manage: { calls: 290, toolFailures: 3, others: 0, faultDays: 2, lastFaultDay: 2, run: null,
              finding: { kind: "count", text: "3 tool failures in 290 calls" }, today: "red" },
    eval: { calls: 35, toolFailures: 0, others: 1, faultDays: 0, lastFaultDay: null, run: { days: 3, atLeast: false, through: 1 },
            finding: { kind: "no_failure", text: "No tool failure recorded in 35 calls since {coverage}" }, today: "clear" },
  },
  /** The day states a reader must find, by `k`: the fault days, a malformed call's day, a door's quiet day. */
  states: { core: { 10: "marked", 2: "clear", 1: "clear" }, manage: { 5: "red", 2: "marked", 7: "none" }, eval: { 4: "none" } },
  /** D-19 to D-1 have calls; D-10 is the one at 1% across every door, so two runs of 9 tie and the earlier stands. */
  records: { daysWithWork: 19, daysUnderOnePercent: 21, longest: { days: 9, from: 19, to: 11 } },
  /** The revisions waiting, longest first: team index, path, revision, days waited. */
  pending: [[1, "spec.md", 1, 30], [0, "plan.md", 2, 20], [2, "spec.md", 1, 18], [2, "review.md", 1, 16], [3, "spec.md", 1, 3]] as const,
  /** Instances by kind; the approvals are the teams plover, osprey and wren, longest waiting first. */
  instances: { bugs: 1, door: 2, evaluation: 1, approvals: 3, drift: 2 },
  superadmin: {
    headline: "9 things need you",
    rows: [["bugs", "critical", 1], ["door", "critical", 1], ["door", "critical", 1], ["evaluation", "warning", 1], ["approvals", "warning", 1]],
    doors: ["core", "manage"], approvalsTeam: 1,
    overflowByKind: { approvals: 2, drift: 2 },
  },
  member: {
    headline: "9 things are known and open",
    rows: [["bugs", "critical", 1], ["door", "critical", 1], ["door", "critical", 1], ["evaluation", "warning", 1], ["approvals", "warning", 3]],
    overflowByKind: { drift: 2 },
  },
} as const;

/** Seeds the two people and the teams, the member admin of the first and acting for it, and nothing else: what a
 *  reader finds before `seedNeeds` is the empty assessment. */
export async function seedNeedsPeople(db: pg.ClientBase | pg.Pool): Promise<void> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const person = (email: string, role: string): Promise<string> => one(
    "insert into zz.principal (email, display_name, role) values ($1, $2, $3) returning id", [email, email.split("@")[0], role]);
  const member = await person(NEEDS_MEMBER, "member");
  await person(NEEDS_SUPERADMIN, "superadmin");
  for (const slug of NEEDS_TEAMS) await db.query("insert into zz.team (slug, name, created_by) values ($1, $1, $2)", [slug, member]);
  await db.query(
    `insert into zz.membership (team_id, principal_id, role, added_by) select t.id, $1, 'admin', $1 from zz.team t where t.slug = $2`,
    [member, NEEDS_TEAMS[0]]);
  await db.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where id = $1", [member, NEEDS_TEAMS[0]]);
}

/**
 * Seeds the calls, reports, findings and documents above into `db`, after `seedNeedsPeople`, cutting days in
 * `timezone`, the gateway's `ZZ_TZ`; answers the open real report's id, the one a resolve closes. Read it within the
 * same local day: a reader after midnight finds today's calls on yesterday.
 */
export async function seedNeeds(db: pg.ClientBase | pg.Pool, timezone: string, now = Date.now()): Promise<string> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const member = await one("select id from zz.principal where email = $1", [NEEDS_MEMBER]);
  const teams: string[] = [];
  for (const slug of NEEDS_TEAMS) teams.push(await one("select id from zz.team where slug = $1", [slug]));

  const noon = (k: number): number => dayStart(now, k, timezone) + 12 * 3_600_000;
  const midnight = dayStart(now, 0, timezone);
  const runs: Run[] = [];
  for (const [back, durationMs] of [[6, 100], [5, 150], [4, 300]]) runs.push({ ts: weekStart(now, back, timezone), tool: "core:skill_read", calls: 30, durationMs });
  for (let k = 1; k <= 19; k++) {
    runs.push({ ts: noon(k), tool: "core:document_read", calls: k === 2 ? 50 : 100, theirs: k === 10 ? 1 : 0, ours: k === 2 ? 1 : 0 });
  }
  for (const [k, calls, theirs] of [[6, 50, 0], [5, 20, 1], [4, 50, 0], [3, 50, 0], [2, 50, 1], [1, 50, 0]]) {
    runs.push({ ts: noon(k) + 3_600_000, tool: "manage:whoami", calls, theirs });
  }
  for (const k of [3, 2, 1]) runs.push({ ts: noon(k) + 7_200_000, tool: "eval:protocol_read", calls: 10, other: k === 1 ? 1 : 0 });
  const sofar = (share: number): number => midnight + Math.floor((now - midnight) * share);
  runs.push({ ts: sofar(0.2), tool: "core:document_read", calls: 10, theirs: 1 }, { ts: sofar(0.5), tool: "manage:whoami", calls: 20, theirs: 1 },
            { ts: sofar(0.7), tool: "eval:protocol_read", calls: 5 });
  const calls = runs.flatMap((r) => Array.from({ length: r.calls }, (_, i) => {
    const owner = i < (r.theirs ?? 0) ? "theirs" : i < (r.theirs ?? 0) + (r.ours ?? 0) ? "ours"
      : i < (r.theirs ?? 0) + (r.ours ?? 0) + (r.other ?? 0) ? "other" : null;
    // Today's calls share what is left of the day; the clock may be seconds after midnight.
    const ts = r.ts >= midnight ? Math.min(r.ts + i, now - 1) : r.ts + i * 1000;
    return { ts: new Date(ts).toISOString(), tool: r.tool, owner, duration: r.durationMs ?? null };
  }));
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id, duration_ms)
     select u.ts, 'tool_call', u.tool, u.owner is null, u.tool, u.owner,
            case when u.owner is null then null else 'seeded refusal' end, 'work', $5, $6, u.duration
       from unnest($1::timestamptz[], $2::text[], $3::text[], $4::int[]) as u(ts, tool, owner, duration)`,
    [calls.map((c) => c.ts), calls.map((c) => c.tool), calls.map((c) => c.owner), calls.map((c) => c.duration), teams[0], member]);

  const ago = (days: number): string => new Date(now - days * DAY).toISOString();
  const initiative = (team: string, slug: string, flow: string | null, closed: boolean): Promise<string> => one(
    `insert into zz.initiative (team_id, slug, flow, opened_by, opened_at, closed_at, closed_by, outcome)
     values ($1, $2, $3, $4, $5, case when $6 then $7::timestamptz end, case when $6 then $4::uuid end, case when $6 then 'delivered' end)
     returning id`, [team, slug, flow, member, ago(60), closed, ago(1)]);
  const report = (title: string, status: string, impact: string, team: string | null): Promise<string> => one(
    `insert into zz.bug (reported_at, title, detail, platform_version, impact, status, resolution, resolved_at, team_id, reported_by, resolved_by)
     values ($1, $2, 'seeded', '0.99.0', $3, $4, case when $4 = 'open' then null else 'seeded' end,
             case when $4 = 'open' then null else now() end, $5, $6, case when $4 = 'open' then null else $6::uuid end)
     returning id`, [ago(5), title, impact, status, team, member]);
  const open = await report("seeded open", "open", "blocks_work", teams[0]);
  await report("seeded fixed", "fixed", "confusing", teams[0]);
  await report("chain-check probe 2026-10-01-chain-check-1001-a1b2c3", "open", "blocks_work", null);

  const plugin = await one("insert into zz.plugin (name, origin, owner_team_id) values ('needs-plugin', 'platform', $1) returning id", [teams[0]]);
  const protocol = await one(
    `insert into zz.eval_protocol_version
       (version, purpose, qualification_policy, scoring_policy, improvement_policy, content_digest, created_at,
        plugin_id, protocol_key, observable_surfaces, recorded_by)
     values (1, 'seeded', '{}', '{}', '{}', 'digest-needs', $1, $2, 'needs-protokey', '{}', $3) returning id`, [ago(40), plugin, member]);
  const version = await one("insert into zz.plugin_version (plugin_id, version, digest) values ($1, '1.0.0', 'digest-needs-1') returning id", [plugin]);
  const snapshot = await one(
    `insert into zz.eval_observation_snapshot
       (usable_run_count, total_run_count, evidence_digest, created_at, plugin_version_id, surface_observed,
        surface_total, surface_source, platform_version, recorded_by)
     values (5, 5, 'evidence-needs', $1, $2, 1, 1, null, '0.90.0', $3) returning id`, [ago(40), version, member]);
  const run = await one(
    `insert into zz.eval_run (protocol_version_id, created_at, team_id, observation_snapshot_id, started_by)
     values ($1, $2, $3, $4, $5) returning id`, [protocol, ago(40), teams[0], snapshot, member]);
  const finding = (kind: string, decision: string, days: number, supersededBy: string | null = null): Promise<string> => one(
    `insert into zz.eval_finding (eval_run_id, kind, pattern, owner_kind, decision, created_at, superseded_by)
     values ($1, $2, 'seeded', 'plugin', $3, $4, $5) returning id`, [run, kind, decision, ago(days), supersededBy]);
  const replacing = await finding("defect", "deferred", 20);
  await finding("unknown", "deferred", 15);
  await finding("defect", "deferred", 3);
  await finding("defect", "applied", 30);
  await finding("defect", "rejected", 30, replacing);

  // A document and its revisions, each `[presented days ago | null, approved days ago | null]`, the last current.
  const document = async (init: string, path: string, revisions: [number | null, number | null][]): Promise<void> => {
    await db.query("begin");
    await db.query("set constraints all deferred");
    const doc = await one(
      `insert into zz.doc (initiative_id, path, type, status, updated_at, title, body, current_revision, current_version)
       values ($1, $2, 'seeded', 'draft', now(), $2, 'seeded', $3, $3) returning id`, [init, path, revisions.length]);
    for (const [i, [presented, approved]] of revisions.entries()) {
      await db.query(
        `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash, written_by,
                                      written_at, approved_by, approved_at, presented_at)
         values ($1, $2, $2, 'retained', 'seeded', 'seeded', '{}', $3, $4, $5, case when $6::timestamptz is null then null else $4::uuid end,
                 $6, $7)`,
        [doc, i + 1, `hash-${doc}-${i + 1}`, member, ago(45), approved === null ? null : ago(approved), presented === null ? null : ago(presented)]);
    }
    const approvedAt = revisions.map(([, a], i) => (a === null ? 0 : i + 1)).filter(Boolean).pop() ?? null;
    await db.query("update zz.doc set approved_revision = $2, status = case when $2 = current_revision then 'approved' else 'draft' end where id = $1",
                   [doc, approvedAt]);
    await db.query("commit");
  };
  const [osprey, plover, wren, lark, finch] = teams;
  const ospreyOpen = await initiative(osprey, "2026-08-01-needs-open", "sdlc-flow", false);
  await document(ospreyOpen, "plan.md", [[40, 39], [20, null]]);
  await document(ospreyOpen, "explore.md", [[30, null]]);
  await document(await initiative(osprey, "2026-08-02-needs-closed", "sdlc-flow", true), "spec.md", [[30, null]]);
  await document(await initiative(plover, "2026-08-03-needs-open", "sdlc-flow", false), "spec.md", [[30, null]]);
  const wrenOpen = await initiative(wren, "2026-08-04-needs-open", "sdlc-flow", false);
  await document(wrenOpen, "spec.md", [[18, null]]);
  await document(wrenOpen, "review.md", [[16, null]]);
  await document(wrenOpen, "plan.md", [[30, null], [null, null]]);
  await document(await initiative(lark, "2026-08-05-needs-open", "sdlc-flow", false), "spec.md", [[3, null]]);
  await document(await initiative(lark, "2026-08-06-needs-no-flow", null, false), "spec.md", [[30, null]]);
  await document(await initiative(finch, "2026-08-07-needs-open", "sdlc-flow", false), "spec.md", [[30, 29]]);
  return open;
}
