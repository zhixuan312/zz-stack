/**
 * /api/console/approvals — Approvals: the active team's revisions waiting, and the approvals signed in
 * the caller's name there, each with what the record holds of how it was shown and decided.
 *
 * Waiting is the team's queue: `pendingRevisions` for the active team, each revision once, oldest wait
 * first. Nothing records who must decide a revision, so the queue is labelled `team` and no row is
 * assigned to anybody.
 *
 * History is the caller's alone, never the team's: every `document.document_approve` event of the
 * active team whose `detail.signer` is the caller's email (one signed on somebody's behalf is theirs),
 * and every revision sealed with `approved_by` the caller on a day before the first event naming a
 * signer, read from the revision and dated by that day. Before 8 October each approval wrote two such
 * events and only one named the signer, so the signer is what makes each approval one row. The
 * console's own `document.approve` row and the approve `tool_call` are other kinds and never counted.
 *
 * An approval's presentation is read by joining its review context and content revision to the
 * `document.shown` and `document.shown_part` rows of the same context and target, never by time:
 *
 *   console_revision_shown   a row of that context showed that content revision in the console
 *   agent_context_covered    a row of that context showed it anywhere else (an agent's context)
 *   not_recorded             the context is recorded and none of its rows showed that revision
 *   unknown                  the approval names no review context, or was sealed before the events
 *
 * Its decision basis is `detail.decision_basis` as the caller stated it: `explicit` is
 * `explicit_recorded`, `delegation` is `standing_delegation_recorded`, and none is `unknown`.
 *
 * `tab` chooses which list `limit` and `offset` page; the other answers its first ten rows, and both
 * their totals, so both tabs can show their counts. The summaries and the tiles are over the whole
 * record to the cutoff, never the page. A list whose query fails is `unavailable`, and the other stands.
 *
 * Work is the active team's, for a superadmin too: neither `?team=` nor `?scope=platform` widens it.
 * Nothing here writes.
 *
 * COUPLED: the console's `Approvals`, `ApprovalRow`, `WaitingRow` and `ApprovalEvidence` in
 * src/lib/work-shapes.ts, and its fake answer in scripts/fake-gateway/work-approvals.ts, which
 * `checks/console-work-approvals.ts` compares this route's answer with, key set by key set.
 */
import { contentRevision } from "@zz/contracts";
import type { Express, Request } from "express";

import { platformDb } from "../db.js";
import type { Part, PeriodFigure, ReadMeta } from "./figures.js";
import { pendingRevisions } from "./pending.js";
import { handler, ZZ_TZ } from "./shared.js";
import { grainFor, periodsOf, type Grain, type Period } from "./work-figures.js";

type Presentation = "console_revision_shown" | "agent_context_covered" | "not_recorded" | "unknown";
type DecisionBasis = "explicit_recorded" | "standing_delegation_recorded" | "unknown";
/** One approval in the caller's name. `approvedAt` is a date alone when only the day was recorded. */
type ApprovalRow = {
  initiative: string; path: string; version: number; contentRevision: string; approvedAt: string;
  presentation: Presentation; decisionBasis: DecisionBasis;
};
type WaitingRow = { initiative: string; path: string; version: number; contentRevision: string; waitingSince: string };
type ByInitiative = { initiative: string; count: number }[];
type Approvals = {
  meta: ReadMeta;
  /** null where the list it counts could not be read: a failed read is never a zero. */
  tiles: { waiting: number | null; oldestWaitingSince: string | null; inYourName: number | null; noPresentation: { count: number; of: number } | null };
  weeks: PeriodFigure[];
  waiting: Part<{ rows: WaitingRow[]; total: number; queue: "team"; summary: { byInitiative: ByInitiative; olderThan14Days: number } }>;
  history: Part<{
    rows: ApprovalRow[]; total: number;
    summary: { byPresentation: Record<Presentation, number>; byDecisionBasis: Record<DecisionBasis, number>; byInitiative: ByInitiative };
  }>;
};
/** A requested half-open interval `[from, to)`, two instants. */
type Span = { from: string; to: string };

const PRESENTATIONS: Presentation[] = ["console_revision_shown", "agent_context_covered", "not_recorded", "unknown"];
const BASES: DecisionBasis[] = ["explicit_recorded", "standing_delegation_recorded", "unknown"];
const BASIS = new Map<string, DecisionBasis>([["explicit", "explicit_recorded"], ["delegation", "standing_delegation_recorded"]]);
const TABS = ["waiting", "history"] as const;
/** What the list a tab does not page answers: its first page at the default size. */
const FIRST_PAGE = 10;
/** How many weeks the route's own figure shows, the running one included. */
const SHOWN = 26;
/** How long a revision waits before the summary counts it as old. */
const OLD_MS = 14 * 24 * 3_600_000;
const BAD_PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** One approval as placed on the calendar: its exact time, or the local midnight of the day a revision
 *  sealed before the events was approved on; and whether it names the review context it rests on. */
type Placed = ApprovalRow & { atMs: number; recordedContext: boolean };

type ApprovalEvent = {
  id: string; at_ms: number; initiative: string; path: string; doc_id: string | null;
  context: string | null; target: string | null; basis: string | null; in_console: boolean; covered: boolean;
  current_version: number | null; current_generation: string | null;
};
type Sealed = {
  doc_id: string; initiative: string; path: string; revision: number; version: number; generation: string | null;
  signer: string; day: string; day_ms: number;
};

/** The caller's approvals in `team` to the cutoff, newest first, and when the events naming a signer
 *  began (null while none does). Two statements and the instant the events began, then matched here:
 *  a content revision is a hash of the document and its generation, which no statement can reverse,
 *  so this is the one place a token is compared. */
async function approvalsOf(team: string, caller: string, asOf: string): Promise<{ rows: Placed[]; beganMs: number | null }> {
  const db = platformDb();
  const [events, sealed, began] = await Promise.all([
    db.query<ApprovalEvent>(
      `select e.id::text as id, (extract(epoch from e.ts) * 1000)::float8 as at_ms, i.slug as initiative,
              substr(e.subject, length(i.slug) + 2) as path, d.id::text as doc_id,
              e.detail->>'review_context' as context, e.detail->>'content_revision' as target,
              e.detail->>'decision_basis' as basis,
              exists (select 1 from zz.event s
                       where s.initiative_id = e.initiative_id and s.subject = e.subject
                         and s.kind in ('document.shown', 'document.shown_part')
                         and s.detail->>'review_context' = e.detail->>'review_context'
                         and s.detail->>'target' = e.detail->>'content_revision'
                         and s.detail->>'via' = 'console') as in_console,
              exists (select 1 from zz.event s
                       where s.initiative_id = e.initiative_id and s.subject = e.subject
                         and s.kind in ('document.shown', 'document.shown_part')
                         and s.detail->>'review_context' = e.detail->>'review_context'
                         and s.detail->>'target' = e.detail->>'content_revision') as covered,
              cur.version as current_version,
              coalesce(cur.content_generation, d.content_generation)::text as current_generation
         from zz.event e
         join zz.team t on t.id = e.team_id
         join zz.initiative i on i.id = e.initiative_id
         left join zz.doc d on d.initiative_id = i.id and d.path = substr(e.subject, length(i.slug) + 2)
         left join zz.doc_revision cur on cur.doc_id = d.id and cur.revision = d.current_revision
        where t.slug = $1 and e.kind = 'document.document_approve'
          and lower(e.detail->>'signer') = lower($2) and e.ts <= $3::timestamptz
        order by e.ts, e.id`, [team, caller, asOf]),
    // Every sealed revision of the team, whoever signed it: an event's content revision names its
    // snapshot whoever holds the seal now. A seal is the reporting calendar's day, written as a date, so
    // it is read and compared as one: its date, and its local midnight as the instant it is placed at.
    // DELIBERATE: `approved_at::date`, not `at time zone ZZ_TZ`. The date was cast to a timestamptz in the
    // database session's zone, which both pools share (production holds every seal at UTC midnight), so
    // only the session's own zone gives the written date back; ZZ_TZ would move it a day west of UTC.
    db.query<Sealed>(
      `select d.id::text as doc_id, i.slug as initiative, d.path, r.revision, r.version,
              coalesce(r.content_generation, case when r.revision = d.current_revision then d.content_generation end)::text as generation,
              lower(a.email) as signer, to_char(r.approved_at::date, 'YYYY-MM-DD') as day,
              (extract(epoch from (r.approved_at::date::timestamp at time zone $2::text)) * 1000)::float8 as day_ms
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         join zz.doc_revision r on r.doc_id = d.id
         join zz.principal a on a.id = r.approved_by
        where t.slug = $1 and r.approved_at::date <= ($3::timestamptz at time zone $2::text)::date
        order by d.id, r.revision`, [team, ZZ_TZ, asOf]),
    db.query<{ began_ms: number | null; day: string | null }>(
      `select (extract(epoch from min(e.ts)) * 1000)::float8 as began_ms, to_char(min(e.ts) at time zone $2::text, 'YYYY-MM-DD') as day
         from zz.event e
        where e.kind = 'document.document_approve' and e.detail->>'signer' is not null and e.ts <= $1::timestamptz`, [asOf, ZZ_TZ]),
  ]);
  const me = caller.toLowerCase();
  const beganDay = began.rows[0]?.day ?? null;
  const tokenOf = (s: Sealed): string | null => (s.generation === null ? null : contentRevision(s.doc_id, Number(s.generation)));
  const named = new Map<string, Sealed>();
  for (const s of sealed.rows) {
    const t = tokenOf(s);
    if (t) named.set(t, s);
  }
  const claimed = new Set<string>();
  const claim = (s: Sealed): Sealed => { claimed.add(`${s.doc_id}:${s.revision}`); return s; };
  const free = (s: Sealed): boolean => !claimed.has(`${s.doc_id}:${s.revision}`);
  const rows: Placed[] = [];
  const unnamed: ApprovalEvent[] = [];
  for (const e of events.rows) {
    const s = e.target ? named.get(e.target) : undefined;
    if (s) rows.push(fromEvent(e, claim(s).version, e.target!));
    else unnamed.push(e);
  }
  // An event naming no snapshot it can be matched to takes the caller's earliest sealed revision of its
  // document that no other approval has claimed, in the order the events were recorded.
  for (const e of unnamed) {
    const s = sealed.rows.find((x) => x.doc_id === e.doc_id && x.signer === me && free(x) && (beganDay === null || x.day >= beganDay));
    if (s) claim(s);
    const current = e.doc_id && e.current_generation !== null ? contentRevision(e.doc_id, Number(e.current_generation)) : "";
    rows.push(fromEvent(e, s?.version ?? e.current_version ?? 0, e.target ?? (s ? tokenOf(s) : null) ?? current));
  }
  // Sealed before the events began: nothing is known of how it was shown or decided.
  for (const s of sealed.rows) {
    if (s.signer !== me || !free(s) || (beganDay !== null && s.day >= beganDay)) continue;
    rows.push({
      initiative: s.initiative, path: s.path, version: s.version, contentRevision: tokenOf(s) ?? "", approvedAt: s.day,
      presentation: "unknown", decisionBasis: "unknown", atMs: s.day_ms, recordedContext: false,
    });
  }
  rows.sort((a, b) => b.atMs - a.atMs || a.initiative.localeCompare(b.initiative) || a.path.localeCompare(b.path) || b.version - a.version);
  return { rows, beganMs: began.rows[0]?.began_ms ?? null };
}

/** An approval event as a row: its presentation by its own context and snapshot alone. */
function fromEvent(e: ApprovalEvent, version: number, token: string): Placed {
  const presentation: Presentation = !e.context ? "unknown"
    : e.in_console ? "console_revision_shown"
    : e.covered ? "agent_context_covered"
    : "not_recorded";
  return {
    initiative: e.initiative, path: e.path, version, contentRevision: token, approvedAt: iso(e.at_ms),
    presentation, decisionBasis: BASIS.get(e.basis ?? "") ?? "unknown", atMs: e.at_ms, recordedContext: !!e.context,
  };
}

const rowOf = ({ atMs: _, recordedContext: __, ...row }: Placed): ApprovalRow => row;
const within = (rows: Placed[], span: Span): Placed[] =>
  rows.filter((r) => r.atMs >= Date.parse(span.from) && r.atMs < Date.parse(span.to));

/** Approvals counted by period over `span`, each once; a period reaching past the span or the cutoff
 *  is observed only as far as both, and complete only when it lies wholly inside them. */
function figures(rows: Placed[], periods: Period[]): PeriodFigure[] {
  return periods.map(({ window }) => {
    // `periodsOf` answers only periods the window reaches, so each is observed over some part of it.
    const [a, b] = [Date.parse(window.observedFrom!), Date.parse(window.observedThrough!)];
    const n = rows.filter((r) => r.atMs >= a && r.atMs < b).length;
    return { window, figure: { value: n, why: null }, numerator: n, denominator: null };
  });
}

/** The caller's approvals in `team` that fall in `span`, newest first: what `callerApprovals` reduces. */
export async function callerApprovalRows(team: string, caller: string, span: Span, asOf: string): Promise<ApprovalRow[]> {
  return within((await approvalsOf(team, caller, asOf)).rows, span).map(rowOf);
}

/** The caller's approvals in `team` by period of `grain` over `span`, each counted once, the running
 *  period not complete; `total` is every one in the span. Home's paired figure and Record's foot. */
export async function callerApprovals(
  team: string, caller: string, span: Span, asOf: string, grain: Grain,
): Promise<{ periods: PeriodFigure[]; total: number }> {
  const rows = within((await approvalsOf(team, caller, asOf)).rows, span);
  return { periods: figures(rows, await periodsOf(span, asOf, grain)), total: rows.length };
}

/** The active team's queue at the cutoff: `pendingRevisions`' rows of the team, each with the version
 *  and content revision of the snapshot waiting. */
async function queueOf(team: string, asOf: string): Promise<WaitingRow[]> {
  const [pending, current] = await Promise.all([
    pendingRevisions(asOf),
    platformDb().query<{ initiative: string; path: string; revision: number; version: number; doc_id: string; generation: string }>(
      `select i.slug as initiative, d.path, r.revision, r.version, d.id::text as doc_id,
              coalesce(r.content_generation, d.content_generation)::text as generation
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
        where t.slug = $1 and i.closed_at is null and r.presented_at is not null and r.approved_at is null`, [team]),
  ]);
  const at = new Map(current.rows.map((r) => [`${r.initiative}\0${r.path}\0${r.revision}`, r]));
  return pending.filter((p) => p.team === team).flatMap((p) => {
    const r = at.get(`${p.initiative}\0${p.path}\0${p.revision}`);
    return r ? [{
      initiative: p.initiative, path: p.path, version: r.version,
      contentRevision: contentRevision(r.doc_id, Number(r.generation)), waitingSince: iso(p.presentedMs),
    }] : [];
  });
}

/** How many rows of each initiative, the most first. */
function byInitiative(rows: { initiative: string }[]): ByInitiative {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.initiative, (n.get(r.initiative) ?? 0) + 1);
  return [...n].map(([initiative, count]) => ({ initiative, count }))
    .sort((a, b) => b.count - a.count || a.initiative.localeCompare(b.initiative));
}
const tallied = <K extends string>(keys: K[], of: (k: K) => number): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, of(k)])) as Record<K, number>;

/** A list as read, or `unavailable` when its statement failed; the failure is logged under `what`. */
async function part<T>(what: string, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { state: "ok", data: await read() };
  } catch (err) {
    console.error(`console approvals: ${what} could not be read:`, err);
    return { state: "unavailable", reason: "query_failed" };
  }
}

/** One query parameter given at most once: its text, null when absent, false when repeated. */
const one = (v: unknown): string | null | false => (v === undefined ? null : typeof v === "string" ? v : false);

/** The tab and its page, or the refusal. */
function parse(req: Request): { tab: (typeof TABS)[number]; limit: number; offset: number } | string {
  const [tab, limitText, offsetText] = ["tab", "limit", "offset"].map((k) => one(req.query[k]));
  if (tab === false || limitText === false || offsetText === false) return "each filter and the page are given at most once";
  if (tab !== null && !(TABS as readonly string[]).includes(tab)) return `tab must be one of ${TABS.join(", ")}`;
  const limit = Number(limitText ?? FIRST_PAGE), offset = Number(offsetText ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return { tab: (tab ?? "waiting") as (typeof TABS)[number], limit, offset };
}

export function mountApprovals(app: Express): void {
  // The scope is resolved and refused by `handler`, and then not read: Work is the active team's.
  app.get("/api/console/approvals", handler("approvals", async (req, res, _scope) => {
    const asked = parse(req);
    if (typeof asked === "string") {
      res.status(400).json({ error: asked });
      return;
    }
    const team = req.zzIdentity!.activeTeam;
    if (!team) {
      res.status(400).json({ error: "no active team — join a team first" });
      return;
    }
    const caller = req.zzIdentity!.email;
    // One instant for every statement, in whole seconds so the cutoff is the `asOf` the answer states.
    const asOfMs = Math.floor(Date.now() / 1000) * 1000;
    const asOf = new Date(asOfMs).toISOString();
    const page = <T>(rows: T[], paged: boolean): T[] =>
      (paged ? rows.slice(asked.offset, asked.offset + asked.limit) : rows.slice(0, FIRST_PAGE));

    const [queue, record] = await Promise.all([
      part("the waiting queue", () => queueOf(team, asOf)),
      part("the caller's approvals", async () => {
        const read = await approvalsOf(team, caller, asOf);
        // From the week of the caller's first approval, at most the newest 26 weeks, through the cutoff.
        const first = read.rows.at(-1)?.atMs ?? asOfMs;
        const shown = { from: iso(Math.max(first, asOfMs - (SHOWN - 1) * 7 * 86_400_000)), to: asOf };
        const periods = await periodsOf(shown, asOf, grainFor(shown));
        const span = { from: iso(periods[0]?.fromMs ?? asOfMs), to: asOf };
        return { ...read, span, weeks: figures(read.rows, await periodsOf(span, asOf, grainFor(span))) };
      }),
    ]);

    const waiting = queue.state === "ok" ? queue.data : [];
    const mine = record.state === "ok" ? record.data.rows : [];
    const recorded = mine.filter((a) => a.recordedContext);
    const answer: Approvals = {
      meta: {
        asOf: iso(asOfMs), timezone: ZZ_TZ,
        period: { from: record.state === "ok" ? record.data.span.from : iso(asOfMs), to: iso(asOfMs) },
        scope: "caller-in-active-team",
        population: `${team}'s revisions waiting, and the approvals signed in the caller's name there`,
        coverageFrom: record.state === "ok" && record.data.beganMs !== null ? iso(record.data.beganMs) : null,
      },
      tiles: {
        waiting: queue.state === "ok" ? waiting.length : null,
        oldestWaitingSince: waiting[0]?.waitingSince ?? null,
        inYourName: record.state === "ok" ? mine.length : null,
        noPresentation: record.state === "ok"
          ? { count: recorded.filter((a) => a.presentation === "not_recorded").length, of: recorded.length } : null,
      },
      weeks: record.state === "ok" ? record.data.weeks : [],
      waiting: queue.state === "ok" ? { state: "ok", data: {
        rows: page(waiting, asked.tab === "waiting"), total: waiting.length, queue: "team",
        summary: { byInitiative: byInitiative(waiting), olderThan14Days: waiting.filter((w) => Date.parse(w.waitingSince) < asOfMs - OLD_MS).length },
      } } : queue,
      history: record.state === "ok" ? { state: "ok", data: {
        rows: page(mine, asked.tab === "history").map(rowOf), total: mine.length,
        summary: {
          byPresentation: tallied(PRESENTATIONS, (p) => mine.filter((a) => a.presentation === p).length),
          byDecisionBasis: tallied(BASES, (b) => mine.filter((a) => a.decisionBasis === b).length),
          byInitiative: byInitiative(mine),
        },
      } } : record,
    };
    res.json(answer);
  }));
}
