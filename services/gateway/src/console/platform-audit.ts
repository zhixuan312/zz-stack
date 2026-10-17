/**
 * /api/console/platform/audit — the superadmin's Audit: recorded acts of administration said as
 * sentences, and the latest events of every kind as metadata.
 *
 * `?filter=administration` (the default) answers the kinds that change who may do what or close a
 * report: `admin.*` but `admin.list_oauth_clients`, which is a read, and `ADMINISTRATION`.
 * `?filter=all` answers every event. Page views are in neither. `?kind`, `?team` and `?before` (an
 * instant) narrow either in the query, before the ceiling of the latest 500 events, so a narrow filter
 * reaches an event older than the latest 500; a page is cut from those 500 and never reads past them.
 *
 * What leaves the gateway is metadata, never a body: no `detail` but the keys a sentence is filled
 * from and `via`, compared in the query and never returned; never the `refusal` column; and a subject
 * only for the kinds whose subject is a slug, an email, an id or a tool. A label, a title, a file's
 * name, a reason, a document's details and a search's question stay in the table. A console write is
 * said to be one; no other door is recorded, so none is named. Acts recorded before every writer
 * stamped its origin read `work`, as they were recorded.
 *
 * A member is refused from `platformPublic`'s flag before anything is read, with no name in the
 * refusal. Nothing here writes.
 *
 * The Platform prepared query (platform-query-measures.ts) counts every event but page views by day,
 * kind and team through `auditDays`, and answers its rows through `auditEvents`, the statement this
 * read lists them with.
 *
 * COUPLED: the console's `Audit` and `AuditRow` in src/lib/fleet-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/platform-audit.ts, whose sentences copy the templates below;
 * `checks/console-platform-audit.ts` compares this route's answers with the fake's, key set by key set.
 */
import type { Express, Request } from "express";
import type pg from "pg";

import { platformDb } from "../db.js";
import type { ReadMeta } from "./figures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

const FILTERS = ["administration", "all"] as const;
export type Filter = (typeof FILTERS)[number];

/** The latest events a read reaches, after its filters. */
const CEILING = 500;

/** The administration kinds outside `admin.*`. COUPLED: the query's own `admin.%` rule, and
 *  `isAdministration` below. */
const ADMINISTRATION = ["credential.set", "team.switch", "pat.self_issue", "pat.self_revoke", "bug.resolve", "bug.console_resolve", "bug.delete"];
/** The kinds outside `admin.*` whose subject is a slug, an email or an id. `pat.self_issue`'s is a
 *  label a person typed, so it is not among them. */
const SAFE_SUBJECT = ["credential.set", "team.switch", "pat.self_revoke", "bug.resolve", "bug.console_resolve", "bug.delete"];
/** What administration leaves no event for, which the page names rather than shows. */
const NOT_RECORDED = ["knowledge reindex", "knowledge reconcile", "client setup", "plugin registration", "release record"];

export const KIND = /^[a-z_]+(\.[a-z_]+)?$/;
const BAD_PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type AuditRow = {
  id: string; at: string; actor: string | null; team: string | null; kind: string; subject: string | null;
  ok: boolean | null; refusalOwner: "guardrail" | "ours" | "theirs" | "other" | null; origin: "work" | "platform";
  inConsole: boolean; sentence: string | null;
};
type Audit = { meta: ReadMeta; filter: Filter; rows: AuditRow[]; total: number; ceiling: 500; notRecorded: string[] };

/** One event as the read selects it: metadata, and the detail keys a sentence may read. */
type Event = {
  id: string; ts_ms: number; actor: string | null; team: string | null; kind: string; subject: string | null;
  ok: boolean | null; refusal_owner: AuditRow["refusalOwner"]; origin: AuditRow["origin"]; in_console: boolean;
  role: string | null; status: string | null; reactivated: string | null; from: string | null; detail_team: string | null;
  owner: string | null; pats_revoked: string | null; sessions_revoked: string | null; enrolments_spent: string | null;
};

const isAdministration = (kind: string): boolean =>
  (kind.startsWith("admin.") && kind !== "admin.list_oauth_clients") || ADMINISTRATION.includes(kind);

const counted = (n: string, one: string): string => `${n} ${one}${n === "1" ? "" : "s"}`;

/** The act said from its kind's one template, or null for an event that is not administration. A
 *  kind no template names, as a retired writer's, is said by the fallback. */
function sentence(e: Event): string | null {
  if (!isAdministration(e.kind)) return null;
  const who = e.actor ?? "Someone not recorded";
  const s = e.subject ?? "";
  const [team, email] = [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)];
  const templates: Record<string, () => string> = {
    "admin.create_team": () => `${who} ${e.reactivated === "true" ? "reactivated" : "created"} team ${s}`,
    "admin.archive_team": () => `${who} archived team ${s}`,
    "admin.add_member": () => `${who} added ${email} to ${team}${e.role ? ` as ${e.role}` : ""}`,
    "admin.remove_member": () => `${who} removed ${email} from ${team}`,
    "admin.add_person": () => `${who} added ${s} to the platform`,
    "admin.deactivate_person": () => `${who} deactivated ${s}` +
      (e.pats_revoked && e.sessions_revoked && e.enrolments_spent
        ? `, revoking ${counted(e.pats_revoked, "token")} and ${counted(e.sessions_revoked, "session")}` +
          ` and spending ${counted(e.enrolments_spent, "enrolment link")}`
        : ""),
    "admin.issue_enrolment": () => `${who} issued an enrolment link for ${s}`,
    "admin.issue_pat": () => `${who} issued a token for ${s}${e.detail_team ? ` bound to ${e.detail_team}` : ""}`,
    "admin.revoke_pat": () => `${who} revoked token ${s}${e.owner ? ` of ${e.owner}` : ""}${e.detail_team ? ` bound to ${e.detail_team}` : ""}`,
    "admin.revoke_oauth_client": () => `${who} revoked client ${s}${e.pats_revoked ? `, revoking ${counted(e.pats_revoked, "token")}` : ""}`,
    "credential.set": () => `${who} granted a client a token for ${s.replace(/^oauth:/, "")}`,
    "team.switch": () => `${who} switched to ${s}${e.from ? ` from ${e.from}` : ""}`,
    "pat.self_issue": () => `${who} issued themselves a token`,
    "pat.self_revoke": () => `${who} revoked their own token ${s}`,
    "bug.resolve": () => `${who} resolved report ${s}${e.status ? ` as ${e.status.replace(/_/g, " ")}` : ""}`,
    "bug.console_resolve": () => `${who} resolved report ${s}${e.status ? ` as ${e.status.replace(/_/g, " ")}` : ""}`,
    "bug.delete": () => `${who} deleted report ${s}`,
  };
  const said = templates[e.kind]?.() ?? `${who} recorded ${e.kind}${s ? ` for ${s}` : ""}`;
  return `${said}${e.origin === "platform" ? ", as platform maintenance" : ""}${e.in_console ? " in the console" : ""}`;
}

/** One query parameter given at most once: its text, null when absent, false when repeated. */
const one = (v: unknown): string | null | false => (v === undefined ? null : typeof v === "string" ? v : false);

type Asked = { filter: Filter; kind: string | null; team: string | null; before: string | null; limit: number; offset: number };

/** The filters and the page, or the refusal. */
function parse(req: Request): Asked | string {
  const [filter, kind, team, before, limitText, offsetText] =
    ["filter", "kind", "team", "before", "limit", "offset"].map((k) => one(req.query[k]));
  if (filter === false || kind === false || team === false || before === false || limitText === false || offsetText === false) {
    return "each filter and the page are given at most once";
  }
  if (filter !== null && !(FILTERS as readonly string[]).includes(filter)) return `filter must be one of ${FILTERS.join(", ")}`;
  if (before !== null && Number.isNaN(Date.parse(before))) return "before must be an instant";
  if (kind !== null && !KIND.test(kind)) return "kind must be an event kind";
  const limit = Number(limitText ?? 10), offset = Number(offsetText ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return {
    filter: (filter ?? "administration") as Filter, kind, team,
    before: before === null ? null : new Date(Date.parse(before)).toISOString(), limit, offset,
  };
}

/** What the events statement narrows by: the filter, an event kind, a team's slug, and the instants an event is at or
 *  after (`after`) and before (`before`), each null for no bound; and the latest `limit` events it reaches. A slug
 *  nobody holds narrows to nothing rather than to no filter. */
type EventFilter = { filter: Filter; kind: string | null; team: string | null; after: string | null; before: string | null; limit: number };

/** The latest events `f` keeps up to `asOf`, newest first, page views left out, each as its row: metadata and a
 *  sentence, never a body. */
export async function auditEvents(db: pg.Pool, asOf: string, f: EventFilter): Promise<AuditRow[]> {
  let teamId: string | null = null;
  if (f.team !== null) {
    const t = await db.query<{ id: string }>("select id::text as id from zz.team where slug = $1", [f.team]);
    if (!t.rows.length) return [];
    teamId = t.rows[0].id;
  }
  const events = (await db.query<Event>(
    `select e.id::text as id, (extract(epoch from e.ts) * 1000)::float8 as ts_ms, p.email as actor, t.slug as team, e.kind,
            case when e.kind = 'tool_call' then e.tool_key
                 when e.kind like 'admin.%' or e.kind = any($7::text[]) then e.subject end as subject,
            e.ok, e.refusal_owner, e.origin, coalesce(e.detail->>'via' = 'web', false) as in_console,
            e.detail->>'role' as role, e.detail->>'status' as status, e.detail->>'reactivated' as reactivated,
            e.detail->>'from' as "from", e.detail->>'team' as detail_team, e.detail->>'owner' as owner,
            e.detail->>'patsRevoked' as pats_revoked, e.detail->>'sessionsRevoked' as sessions_revoked,
            e.detail->>'enrolmentsSpent' as enrolments_spent
       from zz.event e
       left join zz.principal p on p.id = e.actor_id
       left join zz.team t on t.id = e.team_id
      where e.ts <= $1::timestamptz and e.kind <> 'console.page_view'
        and ($2::text = 'all' or (e.kind like 'admin.%' and e.kind <> 'admin.list_oauth_clients') or e.kind = any($6::text[]))
        and ($3::text is null or e.kind = $3::text)
        and ($4::uuid is null or e.team_id = $4::uuid)
        and ($5::timestamptz is null or e.ts < $5::timestamptz)
        and ($9::timestamptz is null or e.ts >= $9::timestamptz)
      order by e.ts desc, e.id desc
      limit $8::int`,
    [asOf, f.filter, f.kind, teamId, f.before, ADMINISTRATION, SAFE_SUBJECT, f.limit, f.after])).rows;
  return events.map((e): AuditRow => ({
    id: e.id, at: iso(e.ts_ms), actor: e.actor, team: e.team, kind: e.kind, subject: e.subject, ok: e.ok,
    refusalOwner: e.refusal_owner, origin: e.origin, inConsole: e.in_console, sentence: sentence(e),
  }));
}

/** Every event up to `asOf` but page views, by the local day it was recorded on, its kind and its team's slug (null
 *  for none), with the latest of each: what Audit's `all` filter reaches, counted rather than listed. */
type AuditDay = { day: string; kind: string; team: string | null; n: number; last_ms: number };

export async function auditDays(db: pg.Pool, asOf: string): Promise<AuditDay[]> {
  return (await db.query<AuditDay>(
    `select to_char(e.ts at time zone $1::text, 'YYYY-MM-DD') as day, e.kind, t.slug as team,
            count(*)::int as n,
            (extract(epoch from max(e.ts)) * 1000)::float8 as last_ms
       from zz.event e
       left join zz.team t on t.id = e.team_id
      where e.ts <= $2::timestamptz and e.kind <> 'console.page_view'
      group by 1, 2, 3`, [ZZ_TZ, asOf])).rows;
}

export function mountPlatformAudit(app: Express): void {
  app.get("/api/console/platform/audit", platformPublic("the platform's audit", async (req, res, caller) => {
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
    const asOf = new Date(asOfMs).toISOString();

    // The record begins with its first event.
    const cov = await db.query<{ first_ms: number | null }>(
      `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms
         from zz.event e
        where e.ts <= $1::timestamptz`, [asOf]);
    const coverageMs = cov.rows[0]?.first_ms ?? null;

    const events = await auditEvents(db, asOf, {
      filter: asked.filter, kind: asked.kind, team: asked.team, after: null, before: asked.before, limit: CEILING,
    });

    const rows = events.slice(asked.offset, asked.offset + asked.limit);
    const answer: Audit = {
      meta: {
        asOf: iso(asOfMs), timezone: ZZ_TZ,
        period: { from: coverageMs === null ? iso(asOfMs) : iso(coverageMs), to: iso(asOfMs) },
        scope: "platform-admin",
        population: asked.filter === "all" ? "recorded events, page views left out" : "recorded acts of administration",
        coverageFrom: coverageMs === null ? null : iso(coverageMs),
      },
      filter: asked.filter, rows, total: events.length, ceiling: CEILING, notRecorded: NOT_RECORDED,
    };
    res.json(answer);
  }));
}
