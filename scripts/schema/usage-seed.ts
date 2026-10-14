/**
 * The events the platform's usage is read from, seeded into a throwaway database, and the values a
 * reader must find beside them: `checks/console-platform-usage.ts` drives the gateway's own route
 * over them.
 *
 * Weeks are Monday to Monday in the reporting timezone, counted back from the running one as in
 * `status-seed.ts` (`back` 0 the running week, 1 the last whole week L, 2 L-1, and so on), and every
 * call is placed at a local weekday and hour of its week, Monday 0, one second after the last. No
 * call falls on a Sunday, the one day a daylight-saving change can move a local hour. What it writes,
 * real-work `tool_call` events unless said otherwise:
 *
 *   - back 28: wren's 30 `core:skill_read` calls of 500 ms from the week's first instant, where the
 *     record begins, so 29 weeks are recorded and the 26 newest are shown;
 *   - L-2: heron's 20 `core:knowledge_search` of 300 ms;
 *   - L-1: kestrel's 40 `core:document_read` of 200 ms; heron's 35 `core:knowledge_search` of 300
 *     ms; osprey's 30 refusals of `core:document_read`, each in a session of its own and put right
 *     45 seconds later; 10 maintenance calls, 2 refused;
 *   - L: kestrel's 40 `core:document_read` of 100 ms, 5 with no duration and one that failed with no
 *     refusal owner, which is not a refusal; the follow-up cases (a refusal put right after 30
 *     seconds, one after 90, one followed after 150 seconds, one never followed, one with no
 *     session, one followed only by another tool); heron's 5 `core:knowledge_search` of 400 ms;
 *     osprey's 10 `core:skill_read` of 50 ms and one batched; plover's 3 `manage:whoami` of 20 ms
 *     and 7 calls of a tool no door registers; wren's 35 `core:document_read` of 100 ms; 2 calls of
 *     400 ms in no team and no session; 12 maintenance calls, 5 refused; 5 recorded approvals, a
 *     console approval written beside one, and a maintenance approval;
 *   - the running week: a refusal 5 seconds before the seed's clock, put right 2 seconds later,
 *     so it is still inside its lookahead;
 *   - the platform's own model calls in L-1, L and the running week.
 *
 * `USAGE` is what a reader must find, written out by hand from the list above and not computed
 * from it. `seedUsageNoise` writes page views and events of other kinds, which change nothing.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

import { weekStart } from "./status-seed.ts";

/** Team one is the member's; more than four teams have calls, so the fourth part is `Other`. */
export const TEAMS = ["kestrel-works", "osprey-works", "heron-works", "wren-works", "plover-works"] as const;
type Team = (typeof TEAMS)[number];

export const MEMBER = "member@usage.example.test";
export const SUPERADMIN = "superadmin@usage.example.test";

/** A tool no door registers, and the text every refusal carries: neither may reach any answer. */
export const UNREGISTERED = "core:quokka_unlisted";
export const REFUSAL_TEXT = "seeded refusal text that no answer carries";

/** The vocabulary: what `zz.plugin_tool` records each door serving. */
const VOCABULARY = [["zz-core", "core", ["document_read", "knowledge_search", "skill_read", "document_approve"]],
                    ["zz-access", "manage", ["whoami"]]] as const;

const READ = "core:document_read", SEARCH = "core:knowledge_search", SKILL = "core:skill_read", WHOAMI = "manage:whoami";
const DAY = 86_400_000, HOUR = 3_600_000;

type Owner = "guardrail" | "ours" | "theirs" | "other";
interface Call {
  ts: number; team: Team | null; origin: "work" | "platform"; ok: boolean; owner: Owner | null;
  session: string; tool: string; durationMs: number | null; batched: boolean;
}

/** What `seedUsage` wrote: each week's first instant by `back`, and the moment it read the clock. */
export interface Seeded { now: number; starts: Map<number, number> }

/** `seconds` after local `hour` on weekday `day` (Monday 0, never Sunday) of the week `back` weeks before the running one. */
const at = (s: Seeded, back: number, day: number, hour: number, seconds = 0): number =>
  s.starts.get(back)! + day * DAY + hour * HOUR + seconds * 1000;

function calls(s: Seeded): Call[] {
  const call = (ts: number, over: Partial<Call>): Call =>
    ({ ts, team: "kestrel-works", origin: "work", ok: true, owner: null, session: "", tool: READ, durationMs: null, batched: false, ...over });
  const refused = (ts: number, owner: Owner, over: Partial<Call>): Call => call(ts, { ok: false, owner, ...over });
  /** `n` calls one second apart; the first `owners.length` refused by those owners. */
  const run = (ts: number, n: number, over: Partial<Call>, owners: Owner[] = []): Call[] =>
    Array.from({ length: n }, (_, i) => (i < owners.length ? refused(ts + i * 1000, owners[i], over) : call(ts + i * 1000, over)));
  const maintenance = { origin: "platform", durationMs: 9_999 } as const;
  const out: Call[] = [
    ...run(at(s, 28, 0, 0), 30, { team: "wren-works", tool: SKILL, session: "w28", durationMs: 500 }),
    ...run(at(s, 3, 2, 10), 20, { team: "heron-works", tool: SEARCH, session: "h3", durationMs: 300 }),

    ...run(at(s, 2, 0, 9), 40, { session: "k2", durationMs: 200 }),
    ...run(at(s, 2, 3, 14), 35, { team: "heron-works", tool: SEARCH, session: "h2", durationMs: 300 }),
    ...run(at(s, 2, 1, 3), 10, { ...maintenance, session: "m2" }, ["ours", "ours"]),

    ...run(at(s, 1, 0, 8), 40, { session: "k1", durationMs: 100 }),
    ...run(at(s, 1, 1, 9), 5, { session: "k1" }),
    call(at(s, 1, 1, 9, 600), { session: "k1", ok: false }),
    refused(at(s, 1, 1, 11), "guardrail", { session: "f1" }), call(at(s, 1, 1, 11, 30), { session: "f1" }),
    refused(at(s, 1, 1, 11, 600), "ours", { session: "f2" }), call(at(s, 1, 1, 11, 690), { session: "f2" }),
    refused(at(s, 1, 1, 11, 1_200), "theirs", { session: "f3" }), call(at(s, 1, 1, 11, 1_350), { session: "f3" }),
    refused(at(s, 1, 1, 11, 1_800), "other", { session: "f4" }),
    refused(at(s, 1, 1, 11, 2_400), "guardrail", { session: "" }), call(at(s, 1, 1, 11, 2_410), { session: "" }),
    refused(at(s, 1, 1, 11, 3_000), "guardrail", { session: "f6" }), call(at(s, 1, 1, 11, 3_020), { session: "f6", tool: SEARCH }),
    ...run(at(s, 1, 2, 10), 5, { team: "heron-works", tool: SEARCH, session: "h1", durationMs: 400 }),
    ...run(at(s, 1, 2, 15), 10, { team: "osprey-works", tool: SKILL, session: "o1", durationMs: 50 }),
    call(at(s, 1, 2, 15, 600), { team: "osprey-works", tool: SKILL, session: "o1", durationMs: 9_000, batched: true }),
    ...run(at(s, 1, 3, 16), 3, { team: "plover-works", tool: WHOAMI, session: "p1", durationMs: 20 }),
    ...run(at(s, 1, 4, 17), 7, { team: "plover-works", tool: UNREGISTERED, session: "p1", durationMs: 10 }),
    ...run(at(s, 1, 5, 20), 35, { team: "wren-works", session: "w1", durationMs: 100 }),
    ...run(at(s, 1, 5, 21), 2, { team: null, tool: SEARCH, durationMs: 400 }),
    ...run(at(s, 1, 2, 4), 12, { ...maintenance, tool: SEARCH, session: "maint" }, ["guardrail", "guardrail", "guardrail", "guardrail", "theirs"]),

    refused(s.now - 5_000, "guardrail", { session: "late" }), call(s.now - 3_000, { session: "late" }),
  ];
  // L-1's refusals, each in its own session and put right 45 seconds later.
  for (let k = 0; k < 30; k++) {
    const t = at(s, 2, 4, 11, k * 100);
    out.push(refused(t, "guardrail", { team: "osprey-works", session: `g${k}` }), call(t + 45_000, { team: "osprey-works", session: `g${k}` }));
  }
  return out;
}

/**
 * Seeds the teams, the two people, the vocabulary and every event above into `db`, cutting weeks in
 * `timezone`, the gateway's `ZZ_TZ`. The database must hold no other `tool_call`. Read the usage
 * within a minute: the running week's refusal must still be inside its 120 seconds.
 */
export async function seedUsage(db: pg.ClientBase | pg.Pool, timezone: string, now = Date.now()): Promise<Seeded> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const member = await one("insert into zz.principal (email, display_name, role) values ($1, 'member', 'member') returning id", [MEMBER]);
  await one("insert into zz.principal (email, display_name, role) values ($1, 'superadmin', 'superadmin') returning id", [SUPERADMIN]);
  const ids = new Map<string, string>();
  for (const slug of TEAMS) ids.set(slug, await one("insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, member]));
  await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $2)", [ids.get(TEAMS[0]), member]);
  await db.query("update zz.principal set active_team_id = $1 where id = $2", [ids.get(TEAMS[0]), member]);

  for (const [plugin, door, tools] of VOCABULARY) {
    const version = await one(
      `with p as (insert into zz.plugin (name, origin) values ($1, 'platform') returning id)
       insert into zz.plugin_version (plugin_id, version, digest) select id, '1.0.0', 'sha256:usage' from p returning id`, [plugin]);
    for (const tool of tools) await db.query("insert into zz.plugin_tool (plugin_version_id, name, door) values ($1, $2, $3)", [version, tool, door]);
  }

  const s: Seeded = { now, starts: new Map() };
  for (const back of [0, 1, 2, 3, 28]) s.starts.set(back, weekStart(now, back, timezone));
  const list = calls(s);
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id, session, duration_ms, batched)
     select u.ts, 'tool_call', u.tool, u.ok, u.tool, u.owner, case when u.owner is null then null else $9 end, u.origin, u.team, $10,
            u.session, u.duration, u.batched
       from unnest($1::timestamptz[], $2::text[], $3::bool[], $4::text[], $5::text[], $6::uuid[], $7::text[], $8::int[], $11::bool[])
            as u(ts, tool, ok, owner, origin, team, session, duration, batched)`,
    [list.map((c) => new Date(c.ts).toISOString()), list.map((c) => c.tool), list.map((c) => c.ok), list.map((c) => c.owner),
     list.map((c) => c.origin), list.map((c) => (c.team === null ? null : ids.get(c.team))), list.map((c) => c.session),
     list.map((c) => c.durationMs), REFUSAL_TEXT, member, list.map((c) => c.batched)]);

  // Approvals: zz-core's, the console's own row beside one, and one by a maintenance client.
  const approvals: [number, string, string][] = [];
  for (let i = 0; i < 5; i++) approvals.push([at(s, 1, 3, 10, i * 60), "document.document_approve", "work"]);
  approvals.push([at(s, 1, 3, 10, 1), "document.approve", "work"], [at(s, 1, 3, 12), "document.document_approve", "platform"]);
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
     select u.ts, u.kind, 'spec.md', '{}'::jsonb, u.origin, case when u.kind = 'document.approve' then null else $4::uuid end, $5
       from unnest($1::timestamptz[], $2::text[], $3::text[]) as u(ts, kind, origin)`,
    [approvals.map((a) => new Date(a[0]).toISOString()), approvals.map((a) => a[1]), approvals.map((a) => a[2]), ids.get(TEAMS[0]), member]);

  // The platform's own model calls: `[ts, purpose, ok, input tokens, output tokens]`.
  const models: [number, string, boolean, number | null, number | null][] = [
    [at(s, 2, 3, 12), "plugin-judge", true, 200, 20], [at(s, 2, 3, 12, 60), "plugin-judge", true, 200, 20],
    [at(s, 1, 2, 12), "typed-judge", true, 1_000, 100], [at(s, 1, 2, 12, 60), "typed-judge", true, 1_000, 100],
    [at(s, 1, 2, 12, 120), "typed-judge", true, 1_000, 100], [at(s, 1, 2, 12, 180), "typed-judge", false, null, null],
    [at(s, 1, 4, 12), "failure-discover", true, 5_000, 500], [at(s, 1, 4, 12, 60), "failure-discover", true, 5_000, 500],
    [now - 10_000, "typed-judge", true, 1_000, 100],
  ];
  await db.query(
    `insert into zz.model_call (ts, purpose, model, input_tokens, output_tokens, duration_ms, ok, error)
     select u.ts, u.purpose, 'seeded-model', u.input, u.output, 1000, u.ok, case when u.ok then null else 'seeded' end
       from unnest($1::timestamptz[], $2::text[], $3::bool[], $4::int[], $5::int[]) as u(ts, purpose, ok, input, output)`,
    [models.map((m) => new Date(m[0]).toISOString()), models.map((m) => m[1]), models.map((m) => m[2]), models.map((m) => m[3]),
     models.map((m) => m[4])]);
  return s;
}

/** Seeds page views and events of other kinds in every week that has calls, none of which a figure counts. */
export async function seedUsageNoise(db: pg.ClientBase | pg.Pool, s: Seeded): Promise<void> {
  const ts = [3, 2, 1].flatMap((back) => [0, 1, 2, 3, 4, 5].map((day) => new Date(at(s, back, day, 13)).toISOString()));
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id, session)
     select u.ts, k.kind, 'noise', '{"workspace":"platform"}'::jsonb, 'work', p.active_team_id, p.id, 'noise'
       from unnest($1::timestamptz[]) as u(ts)
            cross join (values ('console.page_view'), ('knowledge.add')) as k(kind)
            cross join zz.principal p
      where p.email = $2`, [ts, MEMBER]);
}

type Why = "no_data" | "insufficient" | "unavailable" | null;
/** A week as `[numerator, denominator, value, why]`. */
export type Week = [number | null, number | null, number | null, Why];

/** What a reader must find over `seedUsage`, written out by hand. Weekly figures are keyed by `back`, and a shown week
 *  not listed reads the part's `quiet`. */
export const USAGE = {
  coverageBack: 28, oldestShownBack: 25,
  /** Real-work calls by week; the superadmin's parts are these three teams and `Other`, in that order. */
  calls: { 3: 20, 2: 135, 1: 120, 0: 2 } as Record<number, number>,
  labels: ["kestrel-works", "osprey-works", "heron-works", "Other"],
  parts: { 3: [0, 0, 20, 0], 2: [40, 60, 35, 0], 1: [57, 11, 5, 47], 0: [2, 0, 0, 0] } as Record<number, number[]>,
  refusedShare: { 3: [0, 20, 0, "insufficient"], 2: [30, 135, 3_000 / 135, null], 1: [6, 120, 5, null], 0: [1, 2, 50, "insufficient"],
                  quiet: [0, 0, null, "no_data"] } as Record<number | "quiet", Week>,
  p95Ms: { 3: [null, 20, 300, "insufficient"], 2: [null, 75, 300, null], 1: [null, 102, 400, null], quiet: [null, 0, null, "no_data"] } as
    Record<number | "quiet", Week>,
  sessions: { 3: 1, 2: 32, 1: 10, 0: 1 } as Record<number, number>,
  /** The last whole week, L. */
  traffic: { work: 120, maintenance: 12 },
  refusals: { guardrail: 3, ours: 1, theirs: 1, other: 1, maintenance: 5 },
  /** Refusals put right, the median seconds to the first qualifying call, the refused sessions that went on, and the
   *  refusals that cannot be judged. */
  followup: {
    2: { putRight: [30, 30, 100, null], medianSeconds: [45, null], sessionsContinued: [30, 30, 100, null], unassessable: 0 },
    1: { putRight: [2, 5, 40, "insufficient"], medianSeconds: [60, "insufficient"], sessionsContinued: [4, 5, 80, "insufficient"], unassessable: 1 },
    0: { putRight: [0, 0, null, "no_data"], medianSeconds: [null, "no_data"], sessionsContinued: [0, 0, null, "no_data"], unassessable: 1 },
    quiet: { putRight: [0, 0, null, "no_data"], medianSeconds: [null, "no_data"], sessionsContinued: [0, 0, null, "no_data"], unassessable: 0 },
  } as Record<number | "quiet", { putRight: Week; medianSeconds: [number | null, Why]; sessionsContinued: Week; unassessable: number }>,
  /** Each registered tool called in L, most calls first: `[tool, [first back, median ms, why, calls], [median ms, why, calls]]`. */
  tools: {
    rows: [
      [READ, [2, 200, null, 40], [100, null, 75]],
      [SKILL, [28, 500, null, 30], [50, "insufficient", 10]],
      [SEARCH, [2, 300, null, 35], [400, "insufficient", 7]],
      [WHOAMI, [1, 20, "insufficient", 3], [20, "insufficient", 3]],
    ] as [string, [number, number, Why, number], [number, Why, number]][],
    total: 4,
  },
  /** Real-work calls over the complete weeks shown, `[weekday from Monday, hour, calls]`; every other cell is 0. */
  rhythm: [[0, 8, 40], [0, 9, 40], [1, 9, 6], [1, 11, 11], [2, 10, 25], [2, 15, 11], [3, 14, 35], [3, 16, 3], [4, 11, 60],
           [4, 17, 7], [5, 20, 35], [5, 21, 2]] as [number, number, number][],
  mostUsed: {
    rows: [{ tool: READ, calls: 91 }, { tool: SKILL, calls: 11 }, { tool: SEARCH, calls: 8 }, { tool: "Unregistered tools", calls: 7 },
           { tool: WHOAMI, calls: 3 }],
    total: 4,
  },
  perApproval: { last: [120, 5, 24, null], previous: [135, 0, null, "no_data"] } as { last: Week; previous: Week },
  modelCalls: {
    last: { calls: 6, failed: 1, inputTokens: 13_000, outputTokens: 1_300 },
    previous: { calls: 2, failed: 0, inputTokens: 400, outputTokens: 40 },
    byPurpose: [{ purpose: "typed-judge", calls: 4 }, { purpose: "failure-discover", calls: 2 }],
  },
};
