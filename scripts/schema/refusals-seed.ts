/**
 * The tool calls a team's refusals are counted from, seeded into a throwaway database as `zz.event`
 * rows, and the values a reader must find over them: `checks/console-refusals.ts` calls the gateway's
 * own `refusalWeeks` and `refusalGroups` over them.
 *
 * Every instant is fixed, so nothing depends on the day the check runs. The reporting timezone is
 * Asia/Singapore, eight hours ahead of UTC: day 0 is Monday 7 September 2026, local midnight, and an
 * instant is written as a local day and time from it. The read is cut at day 16 12:00, a Wednesday, so
 * the weeks are W1 (days 0 to 6), W2 (days 7 to 13) and the running W3. Team one's real-work tool calls
 * (`ok` true unless an owner is named; `none` is a refused row with no owner):
 *
 *   W1  c1 ok document_read day 0 07:30         Monday locally, Sunday 23:30 in UTC
 *       c2 ok document_read day 2 10:00, c3 ok document_read day 6 23:59, c4 ok skill_read day 3 09:00
 *       g1 guardrail document_write GATE        day 1 10:00 and day 4 11:00
 *       o2 ours document_edit "Input validation error: Missing required argument path"   day 2 12:00
 *       n3 none skill_read "the answer could not be read"                                  day 5 08:00
 *   W2  c5 ok day 7 00:00, the week's first instant; c6, c7, c8 ok days 8, 9 and 12 09:00
 *       g4 guardrail document_write PLAN        day 8 10:00
 *       o5 ours document_edit "Invalid arguments: section 4 has no check", day 9 10:00, and "section 7", day 10 10:00
 *       g6 guardrail initiative_status "ERROR: run <uuid> is closed", two ids, days 10 and 11 11:00
 *       x7 other finding_record, no text        day 11 15:00
 *   W3  c9, c10 ok days 14 and 15 09:00
 *       g8 guardrail document_approve "ERROR: approval needs a stakeholder"   day 15 10:00, and day 16 13:00, after the cutoff
 *       g9 guardrail document_edit PLAN         day 16 08:00: PLAN's text under another tool
 *   before the weeks: g1's text again, day -1 12:00
 *
 * Beside them, none of which any figure of team one's may count: team one's maintenance (origin
 * `platform`), an ok reindex day 9 03:00, PLAN under document_write day 9 04:00 and a `theirs` reindex
 * day 15 03:00; a page view day 9; team two's GATE under document_write day 4 12:00, its SENTINEL under
 * document_edit day 10 09:30 and an ok call; and a third team's 23 groups, 20 of two refusals and 3 of
 * one, in W2. `ADDED` are the two refusals the check adds to W2 later: a `theirs` and an `other`.
 *
 * `EXPECTED` is what a reader must find, written out by hand from the table above and not computed
 * from it.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

export const TIMEZONE = "Asia/Singapore";
export const TEAM = "refusals-one";
export const OTHER = "refusals-two";
export const MANY = "refusals-many";
/** Team two's refusal text: no answer of team one's may hold it. */
export const SENTINEL = "ERROR: the beacon ledger is locked by the chargeback review";

const HOUR = 3_600_000;
const GATE = "ERROR: GATE_REFUSED spec.md needs explore.md approved";
const PLAN = "ERROR: plan.md cannot be written before spec.md is approved";

/** Local `HH:MM` on day `day` from Monday 7 September 2026, as an instant. */
function at(day: number, time: string): string {
  const [h, m] = time.split(":").map(Number);
  return new Date(Date.UTC(2026, 8, 7 + day, h, m) - 8 * HOUR).toISOString();
}

type Owner = "guardrail" | "ours" | "theirs" | "other";
interface Call {
  team: string; ts: string; tool: string; ok: boolean | null; owner: Owner | null; refusal: string | null;
  origin?: "work" | "platform"; kind?: string;
}
const ok = (team: string, ts: string, tool: string): Call => ({ team, ts, tool, ok: true, owner: null, refusal: null });
const no = (team: string, ts: string, tool: string, owner: Owner | null, refusal: string | null): Call =>
  ({ team, ts, tool, ok: false, owner, refusal });

const CALLS: readonly Call[] = [
  // W1
  ok(TEAM, at(0, "07:30"), "core:document_read"), ok(TEAM, at(2, "10:00"), "core:document_read"),
  ok(TEAM, at(6, "23:59"), "core:document_read"), ok(TEAM, at(3, "09:00"), "core:skill_read"),
  no(TEAM, at(1, "10:00"), "core:document_write", "guardrail", GATE), no(TEAM, at(4, "11:00"), "core:document_write", "guardrail", GATE),
  no(TEAM, at(2, "12:00"), "core:document_edit", "ours", "Input validation error: Missing required argument path"),
  no(TEAM, at(5, "08:00"), "core:skill_read", null, "the answer could not be read"),
  // W2
  ok(TEAM, at(7, "00:00"), "core:document_read"), ok(TEAM, at(8, "09:00"), "core:document_read"),
  ok(TEAM, at(9, "09:00"), "core:document_read"), ok(TEAM, at(12, "09:00"), "core:document_read"),
  no(TEAM, at(8, "10:00"), "core:document_write", "guardrail", PLAN),
  no(TEAM, at(9, "10:00"), "core:document_edit", "ours", "Invalid arguments: section 4 has no check"),
  no(TEAM, at(10, "10:00"), "core:document_edit", "ours", "Invalid arguments: section 7 has no check"),
  no(TEAM, at(10, "11:00"), "core:initiative_status", "guardrail", "ERROR: run 1b4e28ba-2fa1-11d2-883f-0016d3cca427 is closed"),
  no(TEAM, at(11, "11:00"), "core:initiative_status", "guardrail", "ERROR: run 6FA459EA-EE8A-3CA4-894E-DB77E160355E is closed"),
  no(TEAM, at(11, "15:00"), "eval:finding_record", "other", null),
  // W3, and after the cutoff
  ok(TEAM, at(14, "09:00"), "core:document_read"), ok(TEAM, at(15, "09:00"), "core:document_read"),
  no(TEAM, at(15, "10:00"), "core:document_approve", "guardrail", "ERROR: approval needs a stakeholder"),
  no(TEAM, at(16, "08:00"), "core:document_edit", "guardrail", PLAN),
  no(TEAM, at(16, "13:00"), "core:document_approve", "guardrail", "ERROR: approval needs a stakeholder"),
  // Before the weeks
  no(TEAM, at(-1, "12:00"), "core:document_write", "guardrail", GATE),
  // Team one's maintenance, and a page view
  { ...ok(TEAM, at(9, "03:00"), "core:knowledge_reindex"), origin: "platform" },
  { ...no(TEAM, at(9, "04:00"), "core:document_write", "guardrail", PLAN), origin: "platform" },
  { ...no(TEAM, at(15, "03:00"), "core:knowledge_reindex", "theirs", "http 503"), origin: "platform" },
  { team: TEAM, ts: at(9, "05:00"), tool: "home", ok: null, owner: null, refusal: null, kind: "console.page_view" },
  // Team two
  no(OTHER, at(4, "12:00"), "core:document_write", "guardrail", GATE),
  no(OTHER, at(10, "09:30"), "core:document_edit", "guardrail", SENTINEL),
  ok(OTHER, at(10, "09:40"), "core:document_read"),
];

/** The two refusals the check adds to W2: a `theirs` and an `other`. */
export const ADDED: readonly Call[] = [
  no(TEAM, at(12, "14:00"), "core:knowledge_search", "theirs", "upstream answered status 502: Bad Gateway"),
  no(TEAM, at(13, "16:00"), "core:document_read", "other", "the tool answered nothing readable"),
];

/** The third team's rules, one word each: the first 20 refused twice, the last 3 once, each later than the one before. */
export const MANY_RULES = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima",
  "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
] as const;
const MANY_CALLS: readonly Call[] = MANY_RULES.flatMap((rule, i) => Array.from({ length: i < 20 ? 2 : 1 }, (_, k) =>
  no(MANY, new Date(Date.parse(at(8, "00:00")) + (i * 2 + k) * 60_000).toISOString(), "core:document_edit", "guardrail", `ERROR: rule ${rule} is broken`)));

/** The window the reads are made over, the first instant of W1 up to the cutoff, and the cutoff. */
export const WINDOW = { from: at(0, "00:00"), to: at(16, "12:00") };
export const AS_OF = at(16, "12:00");

const owners = (guardrail: number, ours: number, theirs: number, other: number) => ({ guardrail, ours, theirs, other });
const week = (from: string, to: string, observedThrough: string, complete: boolean) =>
  ({ from, to, observedFrom: from, observedThrough, complete });
const W1 = week("2026-09-06T16:00:00Z", "2026-09-13T16:00:00Z", "2026-09-13T16:00:00Z", true);
const W2 = week("2026-09-13T16:00:00Z", "2026-09-20T16:00:00Z", "2026-09-20T16:00:00Z", true);
const W3 = week("2026-09-20T16:00:00Z", "2026-09-27T16:00:00Z", "2026-09-23T04:00:00Z", false);

/** What the reads must answer, written out from the table above. */
export const EXPECTED = {
  /** Team one by week over the window: n3, with no owner, `other`. */
  weeks: [
    { window: W1, complete: true, calls: 8, refused: 4, owners: owners(2, 1, 0, 1) },
    { window: W2, complete: true, calls: 10, refused: 6, owners: owners(3, 2, 0, 1) },
    { window: W3, complete: false, calls: 4, refused: 2, owners: owners(2, 0, 0, 0) },
  ],
  /** Team one's maintenance over the window: three calls, two refused, in no owner. */
  maintenance: { calls: 3, refused: 2 },
  /** The window as one month: what the three weeks sum to. */
  month: [{
    window: { from: "2026-08-31T16:00:00Z", to: "2026-09-30T16:00:00Z", observedFrom: "2026-09-06T16:00:00Z", observedThrough: "2026-09-23T04:00:00Z", complete: false },
    complete: false, calls: 22, refused: 12, owners: owners(7, 3, 0, 2),
  }],
  /** W2 once ADDED is in: one call and one refusal more each for `theirs` and `other`, and no other owner moved. */
  added: { window: W2, complete: true, calls: 12, refused: 8, owners: owners(3, 2, 1, 2) },
  /** Team one's groups over the window, the largest first and then the most recent; the newest text of each. */
  groups: [
    { owner: "guardrail", tool: "core:initiative_status", message: "ERROR: run 6FA459EA-EE8A-3CA4-894E-DB77E160355E is closed", count: 2, lastSeen: "2026-09-18T03:00:00Z" },
    { owner: "ours", tool: "core:document_edit", message: "Invalid arguments: section 7 has no check", count: 2, lastSeen: "2026-09-17T02:00:00Z" },
    { owner: "guardrail", tool: "core:document_write", message: GATE, count: 2, lastSeen: "2026-09-11T03:00:00Z" },
    { owner: "guardrail", tool: "core:document_edit", message: PLAN, count: 1, lastSeen: "2026-09-23T00:00:00Z" },
    { owner: "guardrail", tool: "core:document_approve", message: "ERROR: approval needs a stakeholder", count: 1, lastSeen: "2026-09-22T02:00:00Z" },
    { owner: "other", tool: "eval:finding_record", message: null, count: 1, lastSeen: "2026-09-18T07:00:00Z" },
    { owner: "guardrail", tool: "core:document_write", message: PLAN, count: 1, lastSeen: "2026-09-15T02:00:00Z" },
    { owner: "other", tool: "core:skill_read", message: "the answer could not be read", count: 1, lastSeen: "2026-09-12T00:00:00Z" },
    { owner: "ours", tool: "core:document_edit", message: "Input validation error: Missing required argument path", count: 1, lastSeen: "2026-09-09T04:00:00Z" },
  ],
} as const;

async function insert(db: pg.ClientBase | pg.Pool, teams: Map<string, string>, actor: string, calls: readonly Call[]): Promise<void> {
  for (const c of calls) {
    const tool = c.kind ? null : c.tool;
    await db.query(
      `insert into zz.event (ts, kind, subject, ok, tool_key, refusal, refusal_owner, origin, team_id, actor_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [c.ts, c.kind ?? "tool_call", c.tool, c.ok, tool, c.refusal, c.owner, c.origin ?? "work", teams.get(c.team), actor]);
  }
}

/** Seeds the three teams and their calls; `add` writes ADDED. */
export async function seedRefusals(db: pg.ClientBase | pg.Pool): Promise<{ add: () => Promise<void> }> {
  const person = (await db.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ('refusals@example.test', 'refusals', 'member') returning id")).rows[0].id;
  const teams = new Map<string, string>();
  for (const slug of [TEAM, OTHER, MANY]) {
    teams.set(slug, (await db.query<{ id: string }>(
      "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, person])).rows[0].id);
  }
  await insert(db, teams, person, [...CALLS, ...MANY_CALLS]);
  return { add: () => insert(db, teams, person, ADDED) };
}
