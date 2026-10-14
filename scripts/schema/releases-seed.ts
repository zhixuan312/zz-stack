/**
 * The releases and events the platform's releases are read from, seeded into a throwaway database,
 * and the values a reader must find beside them: `checks/console-platform-releases.ts` drives the
 * gateway's own route over them.
 *
 * The record begins at the first real-work call, placed at Monday 00:00 four weeks before the running
 * one in the reporting timezone (C). Every other time is an offset from the moment of seeding (N), in
 * whole seconds. Five releases, one per state a window can be in:
 *
 *   - 0.9.3 at N-20h and 0.9.2 at N-50h, inside 72 hours of each other: each names the other on the
 *     window the other falls in, and both after-windows are still running, observed through the cutoff;
 *   - 0.9.0 at N-240h, both windows whole: before it 120 calls, 6 malformed (one in another team),
 *     2 tool failures; after it, on one day, one malformed call and one tool failure among 32 calls,
 *     two of them batched and so outside the p95, then 8 calls with no duration recorded, and 30
 *     maintenance calls, a page view and a search event that change nothing;
 *   - 0.8.0 at N-400h, whole: 20 calls before it, under the 30 a rate or a latency stands on, and no
 *     real-work call after it, only maintenance calls and a page view: no rate and no latency;
 *   - 0.7.0 at C-24h, a tag whose section published nothing: its before-window ended before the
 *     record began and was never observed, and its after-window is observed from C only.
 *
 * Calls run one second apart from their batch's first instant. p95 is `percentile_cont(0.95)` over
 * the recorded durations, which every batch holds constant, so it is the duration of the batch the
 * 95th percentile falls in.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

import { UNKNOWN_ACTION } from "../release-record.ts";
import { weekStart } from "./status-seed.ts";

const HOUR = 3_600_000;

/** The team the member is admin of, and a second team whose slug no answer to that member may hold. */
const TEAM_ONE = "osprey-works";
export const TEAM_TWO = "plover-works";

/** The three people a reader signs in as: team one's admin, a superadmin in no team, and a member
 *  in no team. */
export const MEMBER = "member@releases.example.test";
export const SUPERADMIN = "superadmin@releases.example.test";
export const NO_TEAM = "loner@releases.example.test";

type Release = {
  version: string; consoleVersion: string | null; summary: string; changelog: string;
  upgradeNotes: string | null; clientAction: string | null;
};

/** Newest first, as the read answers them. */
export const RELEASES: readonly Release[] = [
  { version: "0.9.3", consoleVersion: null, summary: "Search keeps a result whose title has a colon.",
    changelog: "### Fixed\n\n- Search keeps a result whose title has a colon.\n", upgradeNotes: null, clientAction: null },
  { version: "0.9.2", consoleVersion: "0.30.1", summary: "Releases are read with the windows around them.",
    changelog: "Releases are read with the windows around them.\n\n### Upgrade notes\n\n- **Re-pull the plugins.** Every client takes the new skill text on its next pull.\n",
    upgradeNotes: "- **Re-pull the plugins.** Every client takes the new skill text on its next pull.\n", clientAction: "Re-pull the plugins." },
  { version: "0.9.0", consoleVersion: "0.30.0", summary: "A release records itself.",
    changelog: "A release records itself.\n\n### Added\n\n- **Releases are recorded.** Each tag writes its own row.\n", upgradeNotes: null, clientAction: null },
  { version: "0.8.0", consoleVersion: null, summary: "The nightly reindex skips a node it has already read.",
    changelog: "### Fixed\n\n- The nightly reindex skips a node it has already read.\n", upgradeNotes: null, clientAction: null },
  // A section that published nothing: the read says `No changelog entry` for both.
  { version: "0.7.0", consoleVersion: null, summary: "", changelog: "", upgradeNotes: null, clientAction: UNKNOWN_ACTION },
];

/** When each release was tagged, from N, or from C for the one released before the record began. */
const RELEASED: Record<string, { from: "now" | "coverage"; hours: number }> = {
  "0.9.3": { from: "now", hours: -20 },
  "0.9.2": { from: "now", hours: -50 },
  "0.9.0": { from: "now", hours: -240 },
  "0.8.0": { from: "now", hours: -400 },
  "0.7.0": { from: "coverage", hours: -24 },
};

type Owner = "ours" | "theirs" | "guardrail";

/** One run of seeded tool calls, `hours` after the release `near` was tagged (or after C), one second
 *  apart. The first `ours` are refused as malformed, the next `theirs` as tool failures, the next
 *  `guardrail` as the platform doing its job; the rest succeed, and the last `batched` of them share a
 *  batch's latency. Each lasts `ms`, or records no duration when it is null; a batched one lasts 60 s. */
interface Calls {
  near: string; hours: number; team: "one" | "two"; origin: "work" | "platform";
  calls: number; ours: number; theirs?: number; guardrail?: number; batched?: number; ms: number | null;
}

const CALLS: readonly Calls[] = [
  // C itself: the first real-work call.
  { near: "coverage", hours: 0, team: "one", origin: "work", calls: 40, ours: 2, ms: 300 },
  { near: "0.9.0", hours: -48, team: "one", origin: "work", calls: 100, ours: 5, theirs: 2, guardrail: 3, ms: 500 },
  { near: "0.9.0", hours: -24, team: "two", origin: "work", calls: 20, ours: 1, ms: 2_000 },
  // One day after 0.9.0: one malformed call and one tool failure, each counted where it belongs.
  { near: "0.9.0", hours: 30, team: "one", origin: "work", calls: 32, ours: 1, theirs: 1, batched: 2, ms: 700 },
  { near: "0.9.0", hours: 31, team: "one", origin: "work", calls: 8, ours: 0, ms: null },
  { near: "0.9.0", hours: 31, team: "one", origin: "platform", calls: 30, ours: 10, theirs: 5, ms: 50_000 },
  { near: "0.8.0", hours: -10, team: "one", origin: "work", calls: 20, ours: 1, ms: 400 },
  { near: "0.8.0", hours: 5, team: "one", origin: "platform", calls: 10, ours: 2, ms: 900 },
  // Around 0.9.3 and 0.9.2: N-80h, N-40h and N-10h.
  { near: "0.9.3", hours: -60, team: "one", origin: "work", calls: 100, ours: 2, ms: 200 },
  { near: "0.9.3", hours: -20, team: "two", origin: "work", calls: 100, ours: 3, theirs: 1, ms: 400 },
  { near: "0.9.3", hours: 10, team: "one", origin: "work", calls: 100, ours: 1, ms: 600 },
];

/** Events of other kinds, inside windows, that no figure counts. */
const OTHERS = [
  { near: "0.9.0", hours: 32, kind: "console.page_view", subject: "releases" },
  { near: "0.9.0", hours: 32, kind: "knowledge.search", subject: "release windows" },
  { near: "0.8.0", hours: 6, kind: "console.page_view", subject: "releases" },
] as const;

/** One side of a release as the route must answer it. `observed` says whether its bounds are its own
 *  (`whole`), cut at the cutoff (`running`), cut at the record's start (`late`), or absent (`never`). */
interface ExpectedSide {
  observed: "whole" | "running" | "late" | "never";
  calls: number | null; malformed: number | null; rate: number | null; toolFailures: number | null; p95: number | null;
  rateWhy: "no_data" | "insufficient" | "unavailable" | null; p95Why: "no_data" | "insufficient" | "unavailable" | null;
  overlapping: string[];
}

/** What a reader must find, written out by hand from the lists above and not computed from them. */
export const EXPECTED: { releases: Record<string, { before: ExpectedSide; after: ExpectedSide }>; lastWeek: number } = {
  releases: {
    "0.9.3": {
      before: { observed: "whole", calls: 200, malformed: 5, rate: 25, toolFailures: 1, p95: 400, rateWhy: null, p95Why: null, overlapping: ["0.9.2"] },
      after: { observed: "running", calls: 100, malformed: 1, rate: 10, toolFailures: 0, p95: 600, rateWhy: null, p95Why: null, overlapping: [] },
    },
    "0.9.2": {
      before: { observed: "whole", calls: 100, malformed: 2, rate: 20, toolFailures: 0, p95: 200, rateWhy: null, p95Why: null, overlapping: [] },
      after: { observed: "running", calls: 200, malformed: 4, rate: 20, toolFailures: 1, p95: 600, rateWhy: null, p95Why: null, overlapping: ["0.9.3"] },
    },
    "0.9.0": {
      before: { observed: "whole", calls: 120, malformed: 6, rate: 50, toolFailures: 2, p95: 2_000, rateWhy: null, p95Why: null, overlapping: [] },
      after: { observed: "whole", calls: 40, malformed: 1, rate: 25, toolFailures: 1, p95: 700, rateWhy: null, p95Why: null, overlapping: [] },
    },
    "0.8.0": {
      before: { observed: "whole", calls: 20, malformed: 1, rate: 50, toolFailures: 0, p95: 400, rateWhy: "insufficient", p95Why: "insufficient", overlapping: [] },
      after: { observed: "whole", calls: 0, malformed: 0, rate: null, toolFailures: 0, p95: null, rateWhy: "no_data", p95Why: "no_data", overlapping: [] },
    },
    "0.7.0": {
      before: { observed: "never", calls: null, malformed: null, rate: null, toolFailures: null, p95: null, rateWhy: "unavailable", p95Why: "unavailable", overlapping: [] },
      after: { observed: "late", calls: 40, malformed: 2, rate: 50, toolFailures: 0, p95: 300, rateWhy: null, p95Why: null, overlapping: [] },
    },
  },
  /** 0.9.3 and 0.9.2, in the seven days before the cutoff. */
  lastWeek: 2,
};

/** What `seedReleases` wrote: the moment it read the clock, where the record begins, and each
 *  release's time by version. */
export interface Seeded { now: number; coverage: number; at: Map<string, number> }

/** Where a batch or an event begins. */
const instant = (s: Seeded, near: string, hours: number): number =>
  (near === "coverage" ? s.coverage : s.at.get(near)!) + hours * HOUR;

/** Each seeded real-work call as a reader counts it for itself: its time, its refusal owner, and the
 *  duration a percentile reads, null when none was recorded or the call was batched. */
export function workCalls(s: Seeded): { ts: number; owner: Owner | null; ms: number | null }[] {
  return CALLS.filter((c) => c.origin === "work").flatMap((c) => Array.from({ length: c.calls }, (_, i) => ({
    ts: instant(s, c.near, c.hours) + i * 1000,
    owner: i < c.ours ? "ours" : i < c.ours + (c.theirs ?? 0) ? "theirs" : i < c.ours + (c.theirs ?? 0) + (c.guardrail ?? 0) ? "guardrail" : null,
    ms: i >= c.calls - (c.batched ?? 0) ? null : c.ms,
  })));
}

/**
 * Seeds the two teams, the three people, the releases and every event above into `db`, placing C in
 * `timezone` — the reporting timezone of the gateway that will read them (`ZZ_TZ`).
 *
 * The database must hold no other `tool_call` and no other release: the route counts every one.
 */
export async function seedReleases(db: pg.ClientBase | pg.Pool, timezone: string, clock = Date.now()): Promise<Seeded> {
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

  const now = Math.floor(clock / 1000) * 1000;
  const coverage = weekStart(now, 4, timezone);
  const at = new Map(Object.entries(RELEASED).map(([v, r]) => [v, (r.from === "now" ? now : coverage) + r.hours * HOUR]));
  const seeded: Seeded = { now, coverage, at };

  for (const r of RELEASES) {
    await db.query(
      `insert into zz.release (version, console_version, released_at, summary, changelog, upgrade_notes, client_action)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [r.version, r.consoleVersion, new Date(at.get(r.version)!).toISOString(), r.summary, r.changelog, r.upgradeNotes, r.clientAction]);
  }
  for (const c of CALLS) {
    const from = instant(seeded, c.near, c.hours);
    const ts = Array.from({ length: c.calls }, (_, i) => new Date(from + i * 1000).toISOString());
    const owners: (Owner | null)[] = [
      ...Array<Owner>(c.ours).fill("ours"), ...Array<Owner>(c.theirs ?? 0).fill("theirs"),
      ...Array<Owner>(c.guardrail ?? 0).fill("guardrail"),
    ];
    while (owners.length < c.calls) owners.push(null);
    const batched = Array.from({ length: c.calls }, (_, i) => i >= c.calls - (c.batched ?? 0));
    const ms = batched.map((b) => (b ? 60_000 : c.ms));
    await db.query(
      `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id, duration_ms, batched)
       select u.ts, 'tool_call', 'core:knowledge_search', u.owner is null, 'core:knowledge_search', u.owner,
              case when u.owner is null then null else 'seeded refusal' end, $3, $4, $5, u.ms, u.batched
         from unnest($1::timestamptz[], $2::text[], $6::int[], $7::boolean[]) as u(ts, owner, ms, batched)`,
      [ts, owners, c.origin, c.team === "one" ? one : two, member, ms, batched]);
  }
  for (const o of OTHERS) {
    await db.query(
      `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
       values ($1, $2, $3, '{}'::jsonb, 'work', $4, $5)`,
      [new Date(instant(seeded, o.near, o.hours)).toISOString(), o.kind, o.subject, one, member]);
  }
  return seeded;
}
