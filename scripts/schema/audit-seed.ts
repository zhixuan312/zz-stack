/**
 * The events the platform's Audit read is answered from, seeded into a throwaway database, and the
 * values a reader must find beside them: `checks/console-platform-audit.ts` drives the gateway's own
 * route over them.
 *
 * It stands alone, with its own two teams and people, so it knows every event there is. What it writes:
 *
 *   - `EVENTS`, oldest first, one per minute back from two days ago: every administration kind of
 *     reconciliation 19, a legacy `admin.install_flow` no template names, `admin.list_oauth_clients`,
 *     and one event of each kind that carries free text, each with a sentinel planted where that kind
 *     keeps it. Among them: acts made in the console (`via: web`), one by an actor nobody recorded, one
 *     made by maintenance (`origin: platform`), a credential set over OAuth (`via: mcp-oauth`), and a
 *     report resolved in the console, its two rows at the same instant so the id breaks the tie;
 *   - `BULK` newer `tool_call`s, more than the read's ceiling of 500, so the latest 500 events are all
 *     of them and every event in `EVENTS` is older than the ceiling reaches unfiltered;
 *   - one page view, newer than everything, which neither filter answers.
 *
 * Every instant is a whole second, as the gateway spells one. Each event's `expect` is written out by
 * hand: the subject the read may answer, its sentence and whether it was made in the console.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

export const TEAM_ONE = "osprey-works";
export const TEAM_TWO = "plover-works";

/** The superadmin, a member who is team one's admin, and three people the acts are about. */
export const SUPERADMIN = "superadmin@audit.example.test";
export const MEMBER = "member@audit.example.test";
const NEWCOMER = "newcomer@audit.example.test";
const LEAVER = "leaver@audit.example.test";

const REPORT = "c0000000-0000-4000-8000-0000000000a1";
const DELETED = "c0000000-0000-4000-8000-0000000000a2";
const TOKEN = "c0000000-0000-4000-8000-0000000000b1";
const OWN_TOKEN = "c0000000-0000-4000-8000-0000000000b2";
const RESOURCE = "https://zz.audit.example.test/core/mcp";

/** Every planted sentinel opens with this; no answer may hold it. */
export const SENTINEL = "SENTINEL-AUDIT";

/** The newer tool calls, past the ceiling. */
export const BULK = 505;

interface Event {
  key: string; kind: string; actor: "super" | "member" | null; team: "one" | "two" | null; subject: string;
  detail: Record<string, unknown>; origin?: "work" | "platform";
  call?: { ok: boolean; tool: string; owner?: "guardrail" | "ours" | "theirs" | "other"; refusal?: string };
  /** At the same instant as the event before it. */
  sameInstant?: true;
  expect: { subject: string | null; sentence: string | null; inConsole: boolean };
}

/** Short names for the two actors in the sentences below. */
const S = SUPERADMIN, M = MEMBER;

/** Oldest first. */
export const EVENTS: readonly Event[] = [
  { key: "delete", kind: "bug.delete", actor: "super", team: null, subject: DELETED,
    detail: { title: `${SENTINEL} title of a deleted report` },
    // The report's filing is not in the record, so the act names no day it was filed.
    expect: { subject: DELETED, sentence: `${S} deleted a report the record does not name`, inConsole: false } },
  { key: "reactivate", kind: "admin.create_team", actor: "super", team: "two", subject: TEAM_TWO,
    detail: { reactivated: true },
    expect: { subject: TEAM_TWO, sentence: `${S} reactivated team ${TEAM_TWO}`, inConsole: false } },
  { key: "create", kind: "admin.create_team", actor: "super", team: "one", subject: TEAM_ONE,
    detail: { reactivated: false, via: "web" },
    expect: { subject: TEAM_ONE, sentence: `${S} created team ${TEAM_ONE} in the console`, inConsole: true } },
  { key: "add-member", kind: "admin.add_member", actor: "super", team: "one", subject: `${TEAM_ONE}:${MEMBER}`,
    detail: { role: "admin", via: "web" },
    expect: { subject: `${TEAM_ONE}:${MEMBER}`, sentence: `${S} added ${M} to ${TEAM_ONE} as admin in the console`, inConsole: true } },
  { key: "maintenance", kind: "admin.add_person", actor: "super", team: null, subject: NEWCOMER, detail: {}, origin: "platform",
    expect: { subject: NEWCOMER, sentence: `${S} added ${NEWCOMER} to the platform, as platform maintenance`, inConsole: false } },
  { key: "unrecorded", kind: "admin.issue_enrolment", actor: null, team: null, subject: NEWCOMER, detail: {},
    expect: { subject: NEWCOMER, sentence: `Someone not recorded issued an enrolment link for ${NEWCOMER}`, inConsole: false } },
  { key: "issue-bound", kind: "admin.issue_pat", actor: "super", team: "one", subject: MEMBER,
    detail: { team: TEAM_ONE, label: `${SENTINEL} label of an issued token`, expires_at: "2027-01-01T00:00:00Z", replaced: true },
    expect: { subject: MEMBER, sentence: `${S} issued a token for ${M} bound to ${TEAM_ONE}`, inConsole: false } },
  { key: "issue-unbound", kind: "admin.issue_pat", actor: "super", team: null, subject: NEWCOMER,
    detail: { team: null, label: `${SENTINEL} label of an unbound token`, expires_at: "2027-01-01T00:00:00Z" },
    expect: { subject: NEWCOMER, sentence: `${S} issued a token for ${NEWCOMER}`, inConsole: false } },
  { key: "revoke-pat", kind: "admin.revoke_pat", actor: "super", team: "one", subject: TOKEN,
    detail: { owner: MEMBER, team: TEAM_ONE },
    expect: { subject: TOKEN, sentence: `${S} revoked token ${TOKEN} of ${M} bound to ${TEAM_ONE}`, inConsole: false } },
  { key: "revoke-client", kind: "admin.revoke_oauth_client", actor: "super", team: null, subject: "client_7c1e",
    detail: { patsRevoked: 1, via: "web" },
    expect: { subject: "client_7c1e", sentence: `${S} revoked client client_7c1e, revoking 1 token in the console`, inConsole: true } },
  { key: "list-clients", kind: "admin.list_oauth_clients", actor: "super", team: null, subject: "mcp_oauth_client",
    detail: { count: 3 },
    expect: { subject: "mcp_oauth_client", sentence: null, inConsole: false } },
  { key: "deactivate", kind: "admin.deactivate_person", actor: "super", team: null, subject: LEAVER,
    detail: { via: "web", patsRevoked: 2, sessionsRevoked: 1, enrolmentsSpent: 0 },
    expect: { subject: LEAVER, inConsole: true,
      sentence: `${S} deactivated ${LEAVER}, revoking 2 tokens and 1 session and spending 0 enrolment links in the console` } },
  { key: "remove-member", kind: "admin.remove_member", actor: "super", team: "two", subject: `${TEAM_TWO}:${LEAVER}`, detail: {},
    expect: { subject: `${TEAM_TWO}:${LEAVER}`, sentence: `${S} removed ${LEAVER} from ${TEAM_TWO}`, inConsole: false } },
  { key: "archive", kind: "admin.archive_team", actor: "super", team: "two", subject: TEAM_TWO, detail: { via: "web" },
    expect: { subject: TEAM_TWO, sentence: `${S} archived team ${TEAM_TWO} in the console`, inConsole: true } },
  { key: "install-flow", kind: "admin.install_flow", actor: "super", team: "one", subject: "sdlc", detail: {},
    expect: { subject: "sdlc", sentence: `${S} recorded admin.install_flow for sdlc`, inConsole: false } },
  { key: "credential", kind: "credential.set", actor: "member", team: null, subject: `oauth:${RESOURCE}`,
    detail: { via: "mcp-oauth", client_id: "client_7c1e", expires_at: "2027-01-01T00:00:00Z" },
    expect: { subject: `oauth:${RESOURCE}`, sentence: `${M} granted a client a token for ${RESOURCE}`, inConsole: false } },
  { key: "switch-console", kind: "team.switch", actor: "member", team: "one", subject: TEAM_ONE, detail: { via: "web", from: TEAM_TWO },
    expect: { subject: TEAM_ONE, sentence: `${M} switched to ${TEAM_ONE} from ${TEAM_TWO} in the console`, inConsole: true } },
  { key: "switch-agent", kind: "team.switch", actor: "member", team: "one", subject: TEAM_ONE, detail: {},
    expect: { subject: TEAM_ONE, sentence: `${M} switched to ${TEAM_ONE}`, inConsole: false } },
  { key: "self-issue", kind: "pat.self_issue", actor: "member", team: null, subject: `${SENTINEL} label of my own token`,
    detail: { via: "web" },
    expect: { subject: null, sentence: `${M} issued themselves a token in the console`, inConsole: true } },
  { key: "self-revoke", kind: "pat.self_revoke", actor: "member", team: null, subject: OWN_TOKEN, detail: { via: "web" },
    expect: { subject: OWN_TOKEN, sentence: `${M} revoked their own token ${OWN_TOKEN} in the console`, inConsole: true } },
  { key: "resolve", kind: "bug.resolve", actor: "super", team: null, subject: REPORT, detail: { status: "not_a_bug" },
    expect: { subject: REPORT, sentence: `${S} resolved report ${REPORT} as not a bug`, inConsole: false } },
  { key: "console-resolve", kind: "bug.console_resolve", actor: "super", team: null, subject: REPORT, sameInstant: true,
    detail: { via: "web", status: "not_a_bug" },
    expect: { subject: REPORT, sentence: `${S} resolved report ${REPORT} as not a bug in the console`, inConsole: true } },

  // Everything else: no sentence, and a subject only for a tool call.
  { key: "refused-call", kind: "tool_call", actor: "member", team: "one", subject: "core:document_read",
    detail: { client: "claude-code" },
    call: { ok: false, tool: "core:document_read", owner: "guardrail", refusal: `ERROR: "${SENTINEL} refusal quoting a private draft"` },
    expect: { subject: "core:document_read", sentence: null, inConsole: false } },
  { key: "maintenance-call", kind: "tool_call", actor: null, team: "one", subject: "core:knowledge_add", origin: "platform",
    detail: { client: "zz-migrate" }, call: { ok: true, tool: "core:knowledge_add" },
    expect: { subject: "core:knowledge_add", sentence: null, inConsole: false } },
  { key: "search", kind: "knowledge.search", actor: "member", team: "one", subject: `${SENTINEL} which accounts are on the salary list`,
    detail: { returned: [], broadened: true },
    expect: { subject: null, sentence: null, inConsole: false } },
  { key: "lesson", kind: "knowledge.add", actor: "member", team: "one", subject: "0007",
    detail: { title: `${SENTINEL} title of a lesson`, type: "decision", scope: "team" },
    expect: { subject: null, sentence: null, inConsole: false } },
  { key: "journal", kind: "knowledge.create", actor: null, team: null, subject: "0007",
    detail: { node: "0007", detail: `${SENTINEL} node title in the journal` },
    expect: { subject: null, sentence: null, inConsole: false } },
  { key: "document", kind: "document.write", actor: "member", team: "one", subject: "osprey-search/spec.md",
    detail: { details_ref: "d1", details: [`## ${SENTINEL} section heading of a private document`] },
    expect: { subject: null, sentence: null, inConsole: false } },
  { key: "upload", kind: "upload.start", actor: "member", team: "one", subject: "",
    detail: { filename: `${SENTINEL}-salaries.csv` },
    expect: { subject: null, sentence: null, inConsole: false } },
  { key: "release", kind: "release_apply", actor: "super", team: "one", subject: "",
    detail: { reason: `${SENTINEL} reason a release was applied` },
    expect: { subject: null, sentence: null, inConsole: false } },
  { key: "report", kind: "bug_report", actor: "member", team: "one", subject: REPORT,
    detail: { bug: REPORT, title: `${SENTINEL} title of a filed report` },
    expect: { subject: null, sentence: null, inConsole: false } },
  { key: "passkey", kind: "console.passkey_registered", actor: "member", team: null, subject: "cred_1a2b",
    detail: { label: `${SENTINEL} label of a passkey`, via: "web" },
    expect: { subject: null, sentence: null, inConsole: true } },
  { key: "sign-in", kind: "console.sign_in", actor: "member", team: null, subject: "cred_1a2b", detail: { via: "web" },
    expect: { subject: null, sentence: null, inConsole: true } },
  { key: "console-approval", kind: "document.approve", actor: "member", team: null, subject: "osprey-search/spec.md",
    detail: { via: "web", asked_for: "osprey" },
    expect: { subject: null, sentence: null, inConsole: true } },
];

/** Where `seedAudit` put things: each event's id and instant by key, in `EVENTS`' order, and the
 *  first instant of the bulk calls. */
export interface SeededAudit { ids: Map<string, string>; at: Map<string, number>; bulkFrom: number; first: number }

const MINUTE = 60_000;

/**
 * Seeds the people, the teams and every event above into `db`, which must hold no event of its own.
 * `EVENTS` start two days before `now`, a minute apart, oldest first; the bulk calls a second apart
 * from an hour before `now`; the page view a minute before `now`.
 */
export async function seedAudit(db: pg.ClientBase | pg.Pool, now = Date.now()): Promise<SeededAudit> {
  const base = Math.floor(now / 1000) * 1000;
  const person = async (email: string, role: "member" | "superadmin"): Promise<string> => (await db.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, $3) returning id", [email, email.split("@")[0], role])).rows[0].id;
  const superadmin = await person(SUPERADMIN, "superadmin");
  const member = await person(MEMBER, "member");
  await person(NEWCOMER, "member");
  const team = async (slug: string): Promise<string> => (await db.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, superadmin])).rows[0].id;
  const one = await team(TEAM_ONE);
  const two = await team(TEAM_TWO);
  await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $3)", [one, member, superadmin]);
  await db.query("update zz.principal set active_team_id = $1 where id = $2", [one, member]);
  const actorOf = { super: superadmin, member } as const;
  const teamOf = { one, two } as const;

  const ids = new Map<string, string>(), at = new Map<string, number>();
  let ts = base - 2 * 24 * 60 * MINUTE - MINUTE;
  for (const e of EVENTS) {
    if (!e.sameInstant) ts += MINUTE;
    const { rows } = await db.query<{ id: string }>(
      `insert into zz.event (ts, kind, subject, detail, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) returning id::text as id`,
      [new Date(ts).toISOString(), e.kind, e.subject, JSON.stringify(e.detail), e.call?.ok ?? null, e.call?.tool ?? null,
       e.call?.owner ?? null, e.call?.refusal ?? null, e.origin ?? "work", e.team ? teamOf[e.team] : null,
       e.actor ? actorOf[e.actor] : null]);
    ids.set(e.key, rows[0].id);
    at.set(e.key, ts);
  }

  const bulkFrom = base - 60 * MINUTE;
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, origin, team_id, actor_id)
     select u.ts, 'tool_call', 'core:skill_read', true, 'core:skill_read', 'work', $2, $3
       from unnest($1::timestamptz[]) as u(ts)`,
    [Array.from({ length: BULK }, (_, i) => new Date(bulkFrom + i * 1000).toISOString()), one, member]);
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
     values ($1, 'console.page_view', 'audit', '{"workspace":"platform"}'::jsonb, 'work', $2, $3)`,
    [new Date(base - MINUTE).toISOString(), one, superadmin]);
  return { ids, at, bulkFrom, first: at.get(EVENTS[0].key)! };
}
