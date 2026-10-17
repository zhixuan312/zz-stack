/**
 * /api/console/people — People, the superadmin's read: every person the platform knows, their role,
 * teams, tokens, passkeys, last recorded sign-in and state, with four tiles over everybody.
 *
 * A recorded sign-in is a `console.sign_in` event with the person as its actor, which the passkey
 * ceremony writes; a console session, a token's use or a passkey's registration is not one. A person
 * with none reads `lastSignIn: null`, never a date. `signInsLastWeek` counts them in the last complete
 * Monday week in `ZZ_TZ`, and is no data until the first one was recorded.
 *
 * Anyone but the superadmin is refused 403 from `platformPublic`'s flag before anything is read. Rows
 * sort by the local day a person was added and then by email; `q` matches an email or a name as text,
 * `state` is `active` or `deactivated`, and neither moves a tile. Nothing here writes.
 *
 * The Platform prepared query (platform-query-measures.ts) counts people and sign-ins and answers their
 * rows through `peopleRows` and `signInDays`.
 *
 * COUPLED: the console's `People` and `PersonRow` in src/lib/fleet-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/platform-people.ts; `checks/console-platform-people.ts` compares this route's
 * answer with the fake's, key set by key set.
 */
import type { Express, Request } from "express";
import type pg from "pg";

import { platformDb } from "../db.js";
import type { PeriodFigure, ReadMeta, Window } from "./figures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

export const STATES = ["active", "deactivated"] as const;
const BAD_PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";
const POPULATION = "people, their passkeys and their recorded console sign-ins";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export type PersonRow = {
  email: string; name: string; role: string; status: string; created: string;
  active_team: string; activeTeam: string | null; teams: string[]; tokens: number; last_used: string | null;
  passkeys: number; lastSignIn: string | null; state: "active" | "deactivated";
};
type People = {
  meta: ReadMeta;
  tiles: { people: number; withPasskey: number; neverSignedIn: number; signInsLastWeek: PeriodFigure };
  people: PersonRow[]; total: number;
};

/** One query parameter given at most once: its text, null when absent, false when repeated. */
const one = (v: unknown): string | null | false => (v === undefined ? null : typeof v === "string" ? v : false);

/** The filter and page, or the refusal. An empty `q` is no filter. */
function parse(req: Request): { q: string | null; state: string | null; limit: number; offset: number } | string {
  const [q, state, limitText, offsetText] = ["q", "state", "limit", "offset"].map((k) => one(req.query[k]));
  if (q === false || state === false || limitText === false || offsetText === false) {
    return "each filter and the page are given at most once";
  }
  if (state !== null && !(STATES as readonly string[]).includes(state)) return `state must be one of ${STATES.join(", ")}`;
  const limit = Number(limitText ?? 10), offset = Number(offsetText ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return { q: q?.trim() || null, state, limit, offset };
}

/**
 * Every person `q` and `state` keep, sorted by the local day they were added and then by email, `limit` of them from
 * `offset` (`limit` null for every one). `q` matches an email or a name as text; null is no filter.
 *
 * COUPLED: the filter in `peopleTiles`' statement, which counts the same rows as `total`.
 */
export async function peopleRows(db: pg.Pool, asOf: string, q: string | null, state: string | null, limit: number | null, offset: number): Promise<PersonRow[]> {
  const rows = (await db.query<{
    email: string; name: string; role: string; status: "active" | "deactivated"; created: string; active_team: string;
    teams: string[]; tokens: string; last_used: string | null; passkeys: string; last_sign_in: string | null;
  }>(
    `select p.email::text as email, p.display_name as name, p.role, p.status,
            to_char(p.created_at at time zone $1::text, 'YYYY-MM-DD') as created,
            coalesce(t.slug, '') as active_team,
            (select coalesce(array_agg(tm.slug || ' (' || m.role || ')' order by tm.slug), '{}')
               from zz.membership m join zz.team tm on tm.id = m.team_id
              where m.principal_id = p.id)                                   as teams,
            (select count(*) from zz.pat pt
              where pt.principal_id = p.id and pt.revoked_at is null)        as tokens,
            (select to_char(max(pt.last_used_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from zz.pat pt
              where pt.principal_id = p.id)                                  as last_used,
            (select count(*) from zz.passkey k where k.principal_id = p.id)  as passkeys,
            (select to_char(max(e.ts) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from zz.event e
              where e.kind = 'console.sign_in' and e.actor_id = p.id
                and e.ts <= $2::timestamptz)                                 as last_sign_in
       from zz.principal p
       left join zz.team t on t.id = p.active_team_id
      where ($3::text is null or strpos(lower(p.email::text), lower($3::text)) > 0
                              or strpos(lower(p.display_name), lower($3::text)) > 0)
        and ($4::text is null or p.status = $4::text)
      order by to_char(p.created_at at time zone $1::text, 'YYYY-MM-DD'), p.email
      limit $5 offset $6`,
    [ZZ_TZ, asOf, q, state, limit, offset])).rows;
  return rows.map((r) => ({
    email: r.email, name: r.name, role: r.role, status: r.status, created: r.created,
    active_team: r.active_team, activeTeam: r.active_team || null, teams: r.teams, tokens: Number(r.tokens),
    last_used: r.last_used, passkeys: Number(r.passkeys), lastSignIn: r.last_sign_in, state: r.status,
  }));
}

/** The tiles over everybody, and `total`, the rows `q` and `state` keep: a filter narrows `total`, never a tile. */
async function peopleTiles(db: pg.Pool, asOf: string, q: string | null, state: string | null):
  Promise<{ people: number; withPasskey: number; neverSignedIn: number; total: number }> {
  const tiles = (await db.query<{ people: string; with_passkey: string; never_signed_in: string; total: string }>(
    `select count(*) as people,
            count(*) filter (where exists (select 1 from zz.passkey k where k.principal_id = p.id)) as with_passkey,
            count(*) filter (where p.status = 'active' and not exists (
              select 1 from zz.event e
               where e.kind = 'console.sign_in' and e.actor_id = p.id and e.ts <= $1::timestamptz)) as never_signed_in,
            count(*) filter (where ($2::text is null or strpos(lower(p.email::text), lower($2::text)) > 0
                                                  or strpos(lower(p.display_name), lower($2::text)) > 0)
                               and ($3::text is null or p.status = $3::text)) as total
       from zz.principal p`,
    [asOf, q, state])).rows[0];
  return { people: Number(tiles.people), withPasskey: Number(tiles.with_passkey), neverSignedIn: Number(tiles.never_signed_in), total: Number(tiles.total) };
}

/** Recorded sign-ins up to `asOf`, by the local day (`day`, and the instant it starts) and the person who signed in,
 *  with their role, the first and the latest of each. A sign-in with no actor is nobody's and is not counted. */
type SignInDay = { day: string; day_ms: number; email: string; role: string; n: number; first_ms: number; last_ms: number };

export async function signInDays(db: pg.Pool, asOf: string): Promise<SignInDay[]> {
  return (await db.query<SignInDay>(
    `select to_char(e.ts at time zone $1::text, 'YYYY-MM-DD') as day,
            (extract(epoch from (date_trunc('day', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as day_ms,
            p.email::text as email, p.role,
            count(*)::int as n,
            (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms,
            (extract(epoch from max(e.ts)) * 1000)::float8 as last_ms
       from zz.event e
       join zz.principal p on p.id = e.actor_id
      where e.kind = 'console.sign_in' and e.ts <= $2::timestamptz
      group by 1, 2, 3, 4`, [ZZ_TZ, asOf])).rows;
}

export function mountPeople(app: Express): void {
  app.get("/api/console/people", platformPublic("people", async (req, res, caller) => {
    if (!caller.superadmin) {
      res.status(403).json({ error: "not permitted" });
      return;
    }
    const asked = parse(req);
    if (typeof asked === "string") {
      res.status(400).json({ error: asked });
      return;
    }
    const db = platformDb();
    // One instant for every statement, in whole seconds so the cutoff is the `asOf` the answer states.
    const asOfMs = Math.floor(Date.now() / 1000) * 1000;
    const asOf = iso(asOfMs);

    const rows = await peopleRows(db, asOf, asked.q, asked.state, asked.limit, asked.offset);
    const tiles = await peopleTiles(db, asOf, asked.q, asked.state);

    // The last complete week, cut on the deployment's calendar: from the Monday before the running one.
    const week = (await db.query<{ from_ms: number; to_ms: number }>(
      `select (extract(epoch from ((date_trunc('week', $1::timestamptz at time zone $2::text) - interval '1 week')
                                   at time zone $2::text)) * 1000)::float8 as from_ms,
              (extract(epoch from (date_trunc('week', $1::timestamptz at time zone $2::text)
                                   at time zone $2::text)) * 1000)::float8 as to_ms`,
      [asOf, ZZ_TZ])).rows[0];
    // Where the record of sign-ins begins, and the count in that week, whose bounds are local midnights, so a day is
    // wholly inside it or outside; a statement that fails makes the figure unavailable and the rows stand.
    const signIns = await signInDays(db, asOf).then((days) => ({
      first_ms: days.length ? Math.min(...days.map((d) => d.first_ms)) : null,
      n: days.filter((d) => d.day_ms >= week.from_ms && d.day_ms < week.to_ms).reduce((n, d) => n + d.n, 0),
    }), (err: unknown) => {
      console.error("console people: the sign-ins could not be counted:", err);
      return null;
    });

    const firstMs = signIns?.first_ms ?? null;
    const seen = firstMs !== null && firstMs < week.to_ms;
    const window: Window = {
      from: iso(week.from_ms), to: iso(week.to_ms),
      observedFrom: seen ? iso(Math.max(week.from_ms, firstMs)) : null,
      observedThrough: seen ? iso(week.to_ms) : null,
      complete: seen && firstMs <= week.from_ms,
    };
    const n = signIns === null ? null : signIns.n;
    const signInsLastWeek: PeriodFigure = signIns === null
      ? { window, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null }
      : !seen
        ? { window, figure: { value: null, why: "no_data" }, numerator: null, denominator: null }
        : { window, figure: { value: n, why: null }, numerator: n, denominator: null };

    const answer: People = {
      meta: {
        asOf, timezone: ZZ_TZ, period: { from: firstMs === null ? asOf : iso(firstMs), to: asOf },
        scope: "platform-admin", population: POPULATION, coverageFrom: firstMs === null ? null : iso(firstMs),
      },
      tiles: { people: tiles.people, withPasskey: tiles.withPasskey, neverSignedIn: tiles.neverSignedIn, signInsLastWeek },
      people: rows,
      total: tiles.total,
    };
    res.json(answer);
  }));
}
