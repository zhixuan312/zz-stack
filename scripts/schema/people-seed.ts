/**
 * The people the superadmin's People read is drawn from, seeded into a throwaway database, and what a
 * reader must find beside them: `checks/console-platform-people.ts` drives the gateway's own route over
 * them.
 *
 * Weeks are Monday to Monday in the reporting timezone, counted back from the running one as
 * `status-seed.ts` counts them: `back` 0 is the running week, 1 the last complete week (L). An instant is
 * `hours` after the first instant of its week.
 *
 * What it writes, beside two teams, `alder` and `birch`:
 *
 *   - twelve principals, each added on the Monday of a past week at a stated hour; `ada` is added two
 *     hours after `bo` on the same day, so an order by the instant and an order by the day and then the
 *     email disagree;
 *   - passkeys: two for `ada`, one each for `cy`, `ed` and `fay`;
 *   - `console.sign_in` events with the person as actor: `root` in L, `ada` in L-1 and twice in L, the
 *     first at exactly L's first instant, `cy` in L-2, and `ed` at exactly the running week's first
 *     instant; and one with no actor in L, which is nobody's sign-in;
 *   - what is not a sign-in: `fay`'s passkey registration event, console session and used token;
 *   - tokens: two live and one revoked for `ada`, one live and used for `fay`.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

import { weekStart } from "./status-seed.ts";

export const DOMAIN = "people.example.test";
const at = (local: string): string => `${local}@${DOMAIN}`;

/** The superadmin who reads, and a member of `alder` who is refused. */
export const SUPERADMIN = at("root");
export const MEMBER = at("member");

type Seed = {
  name: string; role: "superadmin" | "member"; status: "active" | "deactivated";
  added: [back: number, hours: number]; teams: [team: "alder" | "birch", role: "admin" | "member"][];
  active: "alder" | "birch" | null; passkeys: number; signIns: [back: number, hours: number][];
};

export const PEOPLE: Record<string, Seed> = {
  root: { name: "Root Admin", role: "superadmin", status: "active", added: [10, 9], teams: [], active: null, passkeys: 0, signIns: [[1, 30]] },
  ada: { name: "Ada Lovelace", role: "member", status: "active", added: [9, 10], teams: [["birch", "member"], ["alder", "admin"]], active: "birch",
    passkeys: 2, signIns: [[2, 12], [1, 0], [1, 50]] },
  bo: { name: "Bo Bramble", role: "member", status: "active", added: [9, 8], teams: [["birch", "member"]], active: null, passkeys: 0, signIns: [] },
  cy: { name: "Cy Quill", role: "member", status: "deactivated", added: [8, 9], teams: [["alder", "member"]], active: null, passkeys: 1, signIns: [[3, 5]] },
  di: { name: "Di Finch", role: "member", status: "deactivated", added: [8, 11], teams: [["birch", "member"]], active: null, passkeys: 0, signIns: [] },
  ed: { name: "Ed Marsh", role: "member", status: "active", added: [7, 9], teams: [["birch", "admin"]], active: null, passkeys: 1, signIns: [[0, 0]] },
  fay: { name: "Fay Holt", role: "member", status: "active", added: [7, 9], teams: [], active: null, passkeys: 1, signIns: [] },
  member: { name: "Mo Reed", role: "member", status: "active", added: [6, 9], teams: [["alder", "admin"]], active: "alder", passkeys: 0, signIns: [] },
  "zed-1": { name: "Zed One", role: "member", status: "active", added: [5, 9], teams: [], active: null, passkeys: 0, signIns: [] },
  "zed-2": { name: "Zed Two", role: "member", status: "active", added: [5, 9], teams: [], active: null, passkeys: 0, signIns: [] },
  "zed-3": { name: "Zed Three", role: "member", status: "active", added: [5, 9], teams: [], active: null, passkeys: 0, signIns: [] },
  "zed-4": { name: "Zed Four", role: "member", status: "active", added: [5, 9], teams: [], active: null, passkeys: 0, signIns: [] },
};

/** The sign-in recorded with no actor, in L. */
const NOBODY_SIGN_IN: [back: number, hours: number] = [1, 20];

/** `ada`'s tokens and `fay`'s: when each was last used, `hours` into L, and whether it is revoked. */
const TOKENS: [person: string, lastUsed: number | null, revoked: boolean][] = [
  ["ada", 3, false], ["ada", null, false], ["ada", null, true], ["fay", 40, false],
];

const HOUR = 3_600_000;

/** What a reader must find, written out by hand from the lists above and not computed from them.
 *  Instants are `[back, hours]`; the read states them in UTC. */
export const EXPECTED = {
  /** Every person, by the local day they were added and then by email. */
  order: ["root", "ada", "bo", "cy", "di", "ed", "fay", "member", "zed-1", "zed-2", "zed-3", "zed-4"],
  tiles: { people: 12, withPasskey: 4, neverSignedIn: 7, signInsLastWeek: 3 },
  /** The latest recorded sign-in of each person; null for nobody's. */
  lastSignIn: {
    root: [1, 30], ada: [1, 50], bo: null, cy: [3, 5], di: null, ed: [0, 0], fay: null, member: null,
    "zed-1": null, "zed-2": null, "zed-3": null, "zed-4": null,
  } as Record<string, [number, number] | null>,
  /** The first recorded sign-in: where the read's coverage begins. */
  firstSignIn: [3, 5] as [number, number],
  passkeys: { ada: 2, cy: 1, ed: 1, fay: 1 } as Record<string, number>,
  tokens: { ada: 2, fay: 1 } as Record<string, number>,
  lastUsed: { ada: [1, 3], fay: [1, 40] } as Record<string, [number, number]>,
  teams: { ada: ["alder (admin)", "birch (member)"], bo: ["birch (member)"], cy: ["alder (member)"], di: ["birch (member)"],
    ed: ["birch (admin)"], member: ["alder (admin)"] } as Record<string, string[]>,
  /** Filters and pages, each with the people it lists and the total it states. */
  filtered: {
    "": [["root", "ada", "bo", "cy", "di", "ed", "fay", "member", "zed-1", "zed-2"], 12],
    "limit=100": [["root", "ada", "bo", "cy", "di", "ed", "fay", "member", "zed-1", "zed-2", "zed-3", "zed-4"], 12],
    "limit=3&offset=2": [["bo", "cy", "di"], 12],
    "offset=11": [["zed-4"], 12],
    "offset=12": [[], 12],
    "state=deactivated": [["cy", "di"], 2],
    "state=active&limit=100": [["root", "ada", "bo", "ed", "fay", "member", "zed-1", "zed-2", "zed-3", "zed-4"], 10],
    "q=LOVE": [["ada"], 1],
    "q=fay%40": [["fay"], 1],
    "q=zed&limit=2&offset=1": [["zed-2", "zed-3"], 4],
    "q=quill&state=active": [[], 0],
    "q=%25": [[], 0],
    "q=_": [[], 0],
  } as Record<string, [string[], number]>,
} as const;

/** What `seedPeople` wrote: each week's first instant by `back`, the moment it read the clock, the timezone
 *  it cut weeks in, and each person's principal id. */
export interface SeededPeople { now: number; timezone: string; starts: Map<number, number>; ids: Map<string, string> }

/** The instant `[back, hours]` names. */
export const instant = (s: SeededPeople, [back, hours]: [number, number]): number => s.starts.get(back)! + hours * HOUR;

/**
 * Seeds the two teams, the twelve people and everything above into `db`, cutting weeks in `timezone`, the
 * reporting timezone of the gateway that will read them (`ZZ_TZ`).
 *
 * The database must hold no other principal and no other `console.sign_in`: the read counts every one.
 */
export async function seedPeople(db: pg.ClientBase | pg.Pool, timezone: string, now = Date.now()): Promise<SeededPeople> {
  const starts = new Map<number, number>();
  for (let back = 0; back <= 10; back++) starts.set(back, weekStart(now, back, timezone));
  const seeded: SeededPeople = { now, timezone, starts, ids: new Map() };
  const ts = (when: [number, number]): string => new Date(instant(seeded, when)).toISOString();

  for (const [local, p] of Object.entries(PEOPLE)) {
    const { rows } = await db.query<{ id: string }>(
      "insert into zz.principal (email, display_name, role, status, created_at) values ($1, $2, $3, $4, $5) returning id",
      [at(local), p.name, p.role, p.status, ts(p.added)]);
    seeded.ids.set(local, rows[0].id);
  }
  const root = seeded.ids.get("root")!;
  const teams = new Map<string, string>();
  for (const slug of ["alder", "birch"]) {
    teams.set(slug, (await db.query<{ id: string }>(
      "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, root])).rows[0].id);
  }
  for (const [local, p] of Object.entries(PEOPLE)) {
    const id = seeded.ids.get(local)!;
    for (const [team, role] of p.teams) {
      await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, $3, $4)",
        [teams.get(team), id, role, root]);
    }
    if (p.active) await db.query("update zz.principal set active_team_id = $1 where id = $2", [teams.get(p.active), id]);
    for (let k = 0; k < p.passkeys; k++) {
      await db.query("insert into zz.passkey (id, principal_id, public_key, label) values ($1, $2, '\\x00'::bytea, 'seeded')",
        [`${local}-key-${k}`, id]);
    }
    for (const when of p.signIns) {
      await db.query(
        `insert into zz.event (ts, kind, subject, ok, detail, actor_id)
         values ($1, 'console.sign_in', $2, true, '{"via":"web"}'::jsonb, $3)`, [ts(when), `${local}-key-0`, id]);
    }
  }
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, detail)
     values ($1, 'console.sign_in', 'unknown-key', true, '{"via":"web"}'::jsonb)`, [ts(NOBODY_SIGN_IN)]);

  for (const [local, used, revoked] of TOKENS) {
    await db.query(
      `insert into zz.pat (principal_id, token_hash, last_used_at, revoked_at)
       values ($1, $2, $3, case when $4 then now() end)`,
      [seeded.ids.get(local), `seeded-${local}-${Math.random()}`, used === null ? null : ts([1, used]), revoked]);
  }
  // `fay` registered a passkey, holds a console session and used a token in L, and never signed in.
  const fay = seeded.ids.get("fay")!;
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, detail, actor_id)
     values ($1, 'console.passkey_registered', 'fay-key-0', true, '{"via":"web"}'::jsonb, $2)`, [ts([1, 39]), fay]);
  await db.query(
    `insert into zz.console_session (principal_id, token_hash, issued_at, expires_at, last_seen_at)
     values ($1, $2, $3, now() + interval '1 hour', $3)`, [fay, `seeded-fay-session-${Math.random()}`, ts([1, 41])]);
  return seeded;
}
