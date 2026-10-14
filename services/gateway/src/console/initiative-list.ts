/**
 * GET /api/console/initiatives: the active team's initiatives, filtered and paged on the server, each
 * row with where zz-core says it goes next.
 *
 * Work is the active team's, for the superadmin too: the team is the one the caller's identity acts
 * for, and nothing the request names widens it, neither a team nor a scope. No row names a team.
 *
 * The parts:
 *
 *   tiles      the team's open, waiting and closed initiatives by outcome, whatever the filters
 *   closures   the team's closures by period and outcome, from the week its first initiative was
 *              opened in through the running one, at the grain that window is drawn at
 *   rows       one page of the filtered initiatives, waiting first, then the most recently touched,
 *              the slug breaking a tie, each with its next move as initiative_status answers it
 *   total      how many initiatives the filters hold
 *   summary    over every filtered initiative, never the page: by state, by flow, when each was
 *              last touched, and how many were open by the end of the last whole week
 *
 * A row's state is its outcome once closed; open, it is waiting while a revision of it waits for
 * approval (pendingRevisions), quiet when nothing of it was written for 14 days or more before the
 * cutoff, or, with nothing written, it was opened that long ago, and open otherwise. Presenting a
 * document stamps no revision, so reading an initiative never wakes it. Its gates are the gated
 * documents its flow declares, the handover left out, as stageOf reads them.
 *
 * The next move is zz-core's, relayed as the person through coreFor in batches of ten names, the
 * batches at once, and recorded as nothing: the relay carries the console session's credential, for
 * which initiative_status writes no event. A batch that fails leaves its rows' next move null and says
 * so in nextMoveState; null means that and nothing else.
 *
 * GET /api/console/initiatives?waiting=1 answers the bell's own rule as it did before this read was
 * rebuilt, for the caller's scope, until the bell is rebuilt on the pending queue.
 *
 * DELIBERATE: no backticks in the comments this module adds. check:sql reads the file as text, and a
 * lone backtick in a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's InitiativeList in src/lib/work-shapes.ts, and its fake answer in
 * scripts/fake-gateway/work-initiatives.ts, which checks/console-work-initiatives.ts compares this
 * route's answer with, key set by key set.
 */
import { OUTCOMES } from "@zz/contracts";
import type { Express } from "express";
import type { Mcp } from "@zz/mcp-client";

import { coreFor } from "../core-as-caller.js";
import { platformDb } from "../db.js";
import type { Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { pendingRevisions } from "./pending.js";
import { handler, platformPublic, stageOf, ZZ_TZ, type StageDoc } from "./shared.js";
import { closuresByWeek, grainFor, lastWholeWeek, periodsOf, type ClosureWeek } from "./work-figures.js";

/** Where an initiative goes next, as initiative_status answers it, its keys spelled as the console's. */
type NextMove = { action: string; stage: string | null; document: string | null; waitingOn: string | null; why: string };
type State = "open" | "waiting" | "quiet" | (typeof OUTCOMES)[number];
type InitiativeRow = {
  slug: string; flow: string | null; nextMove: NextMove | null; state: State;
  gates: { passed: number; of: number };
  lastTouched: string; opened: string; closed: string | null;
};
type ListSummary = {
  total: number;
  byState: Record<State, number>;
  byFlow: { flow: string | null; count: number }[];
  touched: PeriodFigure[];
  previous: { window: Window; total: number };
};
type InitiativeList = {
  meta: ReadMeta;
  tiles: { open: number; waiting: number; closed: { accepted: number; delivered: number; abandoned: number } };
  closures: Part<ClosureWeek[]>;
  rows: InitiativeRow[]; total: number;
  summary: Part<ListSummary>;
  nextMoveState: "ok" | "partial" | "unavailable";
};
/** What a list read is filtered and paged by: a state, a flow by its exact name, text in the slug. */
type ListParams = { state: State | null; flow: string | null; q: string; limit: number; offset: number };
/** Who answers initiative_status: zz-core, called as the person. */
type Relay = Pick<Mcp, "call">;

const STATES: readonly State[] = ["open", "waiting", "quiet", ...OUTCOMES];
const DAY = 24 * 3_600_000;
/** Open, and nothing of it written for this long before the cutoff. */
const QUIET_AFTER = 14 * DAY;
/** The most names one initiative_status call answers. */
const BATCH = 10;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The query's filters and page, each given at most once, or the sentence a 400 says. */
function listParams(query: Record<string, unknown>): ListParams | string {
  for (const name of ["state", "flow", "q", "limit", "offset"]) {
    if (query[name] !== undefined && typeof query[name] !== "string") return "each filter and the page are given at most once";
  }
  const text = (name: string): string | null => (query[name] as string | undefined) ?? null;
  const state = text("state");
  if (state !== null && !STATES.includes(state as State)) return `state must be one of ${STATES.join(", ")}`;
  const limit = Number(text("limit") ?? 10), offset = Number(text("offset") ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    return "limit must be a whole number from 1 to 100, and offset one from 0";
  }
  return { state: state as State | null, flow: text("flow"), q: (text("q") ?? "").trim().toLowerCase(), limit, offset };
}

/** One entry of initiative_status's answer for a list of names: an initiative's state, or why it has none. */
type Entry = {
  initiative: string; error?: string; next_move_absent?: string;
  next_move?: { action: string; stage?: string; document?: string; waiting_on?: string; why: string } | null;
};

/** An entry's next move with the console's keys. zz-core names none for an open initiative no flow governs
 *  and says why in next_move_absent; that is an answer, so it is carried as the action none with that
 *  sentence, and null stays what it means everywhere else: zz-core did not answer. */
function moveOf(e: Entry): NextMove {
  const m = e.next_move;
  if (!m) return { action: "none", stage: null, document: null, waitingOn: null, why: e.next_move_absent ?? "no next move is declared" };
  return { action: m.action, stage: m.stage ?? null, document: m.document ?? null, waitingOn: m.waiting_on ?? null, why: m.why };
}

/** Each named initiative's next move, asked in batches of ten at once; a name whose batch failed, or
 *  which zz-core answered with an error, is missing from the answer and counted. */
async function nextMoves(names: string[], relay: Relay): Promise<{ moves: Map<string, NextMove | null>; missing: number; batches: number; failed: number }> {
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += BATCH) batches.push(names.slice(i, i + BATCH));
  const moves = new Map<string, NextMove | null>();
  let failed = 0;
  await Promise.all(batches.map(async (batch) => {
    try {
      const raw = await relay.call("initiative_status", { initiatives: batch });
      if (raw.startsWith("ERROR")) throw new Error(raw);
      const answer = JSON.parse(raw) as { initiatives: Entry[] };
      for (const e of answer.initiatives) {
        if (e.error !== undefined || !batch.includes(e.initiative)) continue;
        moves.set(e.initiative, moveOf(e));
      }
    } catch (err) {
      console.error("console the initiatives: initiative_status could not be read for a page:", err);
      failed++;
    }
  }));
  return { moves, missing: names.filter((n) => !moves.has(n)).length, batches: batches.length, failed };
}

/** A part as read, or unavailable when its statement failed; the failure is logged under its name. */
async function partOf<T>(what: string, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { state: "ok", data: await read() };
  } catch (err) {
    console.error(`console the initiatives: ${what} could not be read:`, err);
    return { state: "unavailable", reason: "query_failed" };
  }
}

/**
 * The active team's initiatives at the cutoff, as the list answers them: the team's tiles and
 * closures, the page the params name, and the total and summary of every initiative they hold. The
 * relay is how zz-core is asked for the page's next moves. Throws when the initiatives themselves
 * cannot be read; a failed figure makes its own part unavailable and the rest stands.
 */
export async function initiativeList(team: string, params: ListParams, asOf: string, relay: Relay): Promise<InitiativeList> {
  const db = platformDb();
  const asOfMs = Date.parse(asOf);
  const [anchors, docs, facts, pending] = await Promise.all([
    // Each initiative, and the newest revision written of any of its documents and sources.
    db.query<{ slug: string; flow: string | null; outcome: string | null; opened_ms: number; closed_ms: number | null; written_ms: number | null }>(
      `select i.slug, i.flow, i.outcome,
              (extract(epoch from i.opened_at) * 1000)::float8 as opened_ms,
              (extract(epoch from i.closed_at) * 1000)::float8 as closed_ms,
              (select (extract(epoch from max(r.written_at)) * 1000)::float8
                 from zz.doc d
                 join zz.doc_revision r on r.doc_id = d.id
                where d.initiative_id = i.id and r.written_at <= $2::timestamptz) as written_ms
         from zz.initiative i
         join zz.team t on t.id = i.team_id
        where t.slug = $1 and i.slug <> '_knowledge' and i.opened_at <= $2::timestamptz`, [team, asOf]),
    // What stageOf reads of each document to count the gates: its path, type and status. No
    // correction: it decides whether a close was complete, never whether a gate passed.
    db.query<StageDoc & { initiative: string }>(
      `select i.slug as initiative, d.path, d.type, d.status
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1 and i.slug <> '_knowledge'
        order by i.slug, d.path`, [team]),
    // The branch facts that rule a gated document in or out of an initiative.
    db.query<{ initiative: string; fact: string; value: string }>(
      `select i.slug as initiative, f.fact, f.value
         from zz.initiative_fact f
         join zz.initiative i on i.id = f.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1`, [team]),
    pendingRevisions(asOf),
  ]);
  const docsOf = new Map<string, StageDoc[]>();
  for (const d of docs.rows) docsOf.set(d.initiative, [...(docsOf.get(d.initiative) ?? []), d]);
  const factsOf = new Map<string, Record<string, string>>();
  for (const f of facts.rows) factsOf.set(f.initiative, { ...factsOf.get(f.initiative), [f.fact]: f.value });
  const waiting = new Set(pending.filter((p) => p.team === team).map((p) => p.initiative));

  const all = anchors.rows.map((a): InitiativeRow => {
    const closed = a.closed_ms !== null && a.closed_ms <= asOfMs;
    const outcome = closed ? a.outcome : null;
    const touched = a.written_ms ?? a.opened_ms;
    const state: State = outcome !== null ? outcome as State
      : waiting.has(a.slug) ? "waiting" : asOfMs - touched >= QUIET_AFTER ? "quiet" : "open";
    // The manifest's gated documents alone: a flow nothing resolves, or none, declares no gate.
    const gates = stageOf(docsOf.get(a.slug) ?? [], a.flow, { closed, outcome }, factsOf.get(a.slug) ?? {}).gates
      .filter((g) => g.written !== undefined && g.role !== "handover");
    return {
      slug: a.slug, flow: a.flow, nextMove: null, state,
      gates: { passed: gates.filter((g) => g.passed).length, of: gates.length },
      lastTouched: iso(touched), opened: iso(a.opened_ms), closed: closed ? iso(a.closed_ms!) : null,
    };
  });
  const rows = all
    .filter((r) => (params.state === null || r.state === params.state) && (params.flow === null || r.flow === params.flow)
      && (!params.q || r.slug.includes(params.q)))
    .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting")
      || b.lastTouched.localeCompare(a.lastTouched) || a.slug.localeCompare(b.slug));
  const page = rows.slice(params.offset, params.offset + params.limit);

  // The team's whole record, from the week its first initiative was opened in.
  const first = Math.min(...all.map((r) => Date.parse(r.opened)));
  const start = all.length ? (await periodsOf({ from: iso(first), to: asOf }, asOf, "week"))[0]?.fromMs ?? asOfMs : asOfMs;
  const window = { from: iso(start), to: asOf };
  const grain = grainFor(window);
  const within = (at: string, w: Window): boolean => at >= w.from && at < w.to;
  const [relayed, closures, summary] = await Promise.all([
    nextMoves(page.map((r) => r.slug), relay),
    partOf("the closures", () => closuresByWeek(team, window, asOf, grain)),
    partOf("the summary", async (): Promise<ListSummary> => {
      const [periods, previous] = await Promise.all([periodsOf(window, asOf, grain), lastWholeWeek(asOf)]);
      const flows = [...new Set(rows.map((r) => r.flow))];
      return {
        total: rows.length,
        byState: Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.state === s).length])) as Record<State, number>,
        byFlow: flows.map((flow) => ({ flow, count: rows.filter((r) => r.flow === flow).length }))
          .sort((a, b) => b.count - a.count || Number(a.flow === null) - Number(b.flow === null) || String(a.flow).localeCompare(String(b.flow))),
        touched: periods.map((p): PeriodFigure => {
          const n = rows.filter((r) => within(r.lastTouched, p.window)).length;
          return { window: p.window, figure: { value: n, why: null }, numerator: n, denominator: null };
        }),
        previous: { window: previous, total: rows.filter((r) => r.opened < previous.to).length },
      };
    }),
  ]);

  return {
    meta: {
      asOf, timezone: ZZ_TZ, period: { from: window.from, to: asOf }, scope: "active-team",
      population: `${team}'s initiatives, its knowledge shelf's own left out`,
      coverageFrom: all.length ? iso(first) : null,
    },
    tiles: {
      open: all.filter((r) => r.closed === null).length,
      waiting: all.filter((r) => r.state === "waiting").length,
      closed: {
        accepted: all.filter((r) => r.state === "accepted").length,
        delivered: all.filter((r) => r.state === "delivered").length,
        abandoned: all.filter((r) => r.state === "abandoned").length,
      },
    },
    closures,
    rows: page.map((r) => ({ ...r, nextMove: relayed.moves.get(r.slug) ?? null })),
    total: rows.length,
    summary,
    nextMoveState: relayed.failed === relayed.batches && relayed.batches > 0 ? "unavailable"
      : relayed.missing > 0 ? "partial" : "ok",
  };
}

export function mountInitiativeList(app: Express): void {
  /** The list, for the team the caller's identity acts for and no other. */
  const list = platformPublic("the initiatives", async (req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: "no team: Work is the active team's, and you act for none" });
      return;
    }
    const params = listParams(req.query as Record<string, unknown>);
    if (typeof params === "string") { res.status(400).json({ error: params }); return; }
    // The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it.
    res.json(await initiativeList(activeTeam, params, iso(Math.ceil(Date.now() / 1000) * 1000), coreFor(req)));
  });

  /** What the console's alert bell asks, ?waiting=1: its own rule over the caller's scope, moved here
   *  unchanged from the handler it shared with the list, until the bell reads the pending queue. */
  const bell = handler("the waiting gates", async (req, res, scope) => {
    const db = platformDb();
    /* `?team=` is a filter, never a nullable one. Absent means "every team I may see"; present
     * means that one team, and a team scope may only ever name its own — anything else is the
     * same 404 a missing team gets, never a 403 that would confirm it exists.
     * `($1::text is null or team_slug = $1)` would make an absent parameter match every row.
     *
     * DELIBERATE: three complete statements, not one assembled from `scope` at request time.
     * `check:sql` PREPAREs every query in this file against a live schema before release and can
     * only PREPARE a literal it can read whole, so a predicate built from `scope.kind` is
     * invisible to it. Two of the three are the same text with a different bound value. */

    // A team scope may name its own slug and nothing else. Naming another team's is not a
    // narrower request it is entitled to make, so it gets the not-found it would get for a
    // team that does not exist.
    const want = typeof req.query.team === "string" && req.query.team ? req.query.team : null;
    if (scope.kind === "team" && want !== null && want !== scope.slug) {
      res.status(404).json({ error: `no team ${want}` });
      return;
    }
    /* Not `DocRow`, which is the shape of a document read. This route builds a summary per
       initiative — count, stage, who signed — and reads none of the body. Typing the rows as
       DocRow puts `length(coalesce(body,''))` in the select, and Postgres detoasts every body
       to answer it. Carries neither `flow` nor `outcome`: both are the initiative's own, read
       from `zz.initiative` below, never from a document. */
    type ListRow = StageDoc & {
      team_slug: string; initiative: string;
      approved_by: string | null; updated_at: string;
      /** How many revisions of this document carry a seal. A document is approved once per
       *  revision, so this is what the panel's "approvals" column counts — the frozen copy an
       *  approval used to file beside the document is a `doc_revision` row now. */
      approvals: string;
    };
    /* THREE complete statements, not one assembled at request time.
       COUPLED: check:sql PREPAREs every query call in this repository against a live schema
       (scripts/gate/checks/console.ts, through packages/tools/src/lib/sql-scan.ts), and a query
       built from a `where` argument is a variable to that scan — there is no longer one statement
       for it to read, so it is neither prepared nor checked. Written out per branch, the same
       reason the fact and anchor queries above are.
       DELIBERATE: the names in this comment carry no backticks. The scanner reads this file as
       text, comments included, so a backtick here opens a template literal it then parses as code
       — which is how this comment broke the very check it is describing.
       COUPLED: a document reaches its team and its initiative through initiative_id — zz.doc
       carries neither slug — its approver through the revision it currently points at, and its
       supports through that revision's envelope payload. None of the four is a column of zz.doc,
       so a select naming them off it would stop preparing the day the migration lands.
       COUPLED: correction is the same expression in every statement of the bell's that feeds
       stageOf, and in the initiative and document reads of initiatives.ts; StageDoc in shared.ts
       says what it means. The list's own statement leaves it out, since a gate count never reads
       it. It is closedMove's rule in services/zz-core/src/tools/initiative-closed.ts, and abandoned is the
       outcome contracts names OUTCOME_STOPPED. That rule asks for a gated document of the
       initiative's flow, which SQL cannot read off a manifest; a flow on the initiative is the
       stand-in, and an exact one while the manifest is installed and unchanged: under a flow only a
       gated document it declares can be approved (gateRefusal in services/zz-core/src/chain.ts), so
       an approved revision already means gated, and only a freeform initiative, where anything is
       approvable and closedMove sees nothing, needs ruling out. */
    // FR-58 (Task I-27): the same three scope shapes as the docs query above, mirrored for
    // `zz.initiative_fact` (001) — the console's own copy of `<initiative>/
    // _facts.json`, which it cannot read directly (it has no filesystem access to the store).
    // Written as three complete statements rather than one assembled at request time, for the
    // same reason the docs query above is: `check:sql` PREPAREs every statement it can read
    // whole, and a predicate built from `scope.kind` is invisible to it.
    type FactRow = { team: string; initiative: string; fact: string; value: string };
    const { rows: factRows } = scope.kind !== "platform"
      ? await db.query<FactRow>(
      `select t.slug as team, i.slug as initiative, f.fact, f.value
         from zz.initiative_fact f
         join zz.initiative i on i.id = f.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1`, [scope.slug])
      : want !== null
      ? await db.query<FactRow>(
      `select t.slug as team, i.slug as initiative, f.fact, f.value
         from zz.initiative_fact f
         join zz.initiative i on i.id = f.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1`, [want])
      : await db.query<FactRow>(
      `select t.slug as team, i.slug as initiative, f.fact, f.value
         from zz.initiative_fact f
         join zz.initiative i on i.id = f.initiative_id
         join zz.team t on t.id = i.team_id`);
    const factsByInit = new Map<string, Record<string, string>>();
    for (const r of factRows) {
      const key = `${r.team}/${r.initiative}`;
      const got = factsByInit.get(key) ?? {};
      got[r.fact] = r.value;
      factsByInit.set(key, got);
    }

    // The initiative's own lifecycle: `flow`, whether it is closed, and its outcome, all read
    // from `zz.initiative` — the one authority for a state no document derivation may answer
    // any more. Same three scope shapes as the queries above, for the same `check:sql` reason.
    type AnchorRow = { team: string; slug: string; flow: string | null; closed: boolean; outcome: string | null };
    const { rows: anchorRows } = scope.kind !== "platform"
      ? await db.query<AnchorRow>(
      `select t.slug as team, i.slug, i.flow, i.closed_at is not null as closed, i.outcome
         from zz.initiative i join zz.team t on t.id = i.team_id
        where t.slug = $1`, [scope.slug])
      : want !== null
      ? await db.query<AnchorRow>(
      `select t.slug as team, i.slug, i.flow, i.closed_at is not null as closed, i.outcome
         from zz.initiative i join zz.team t on t.id = i.team_id
        where t.slug = $1`, [want])
      : await db.query<AnchorRow>(
      `select t.slug as team, i.slug, i.flow, i.closed_at is not null as closed, i.outcome
         from zz.initiative i join zz.team t on t.id = i.team_id`);
    const anchorByInit = new Map<string, { flow: string | null; closed: boolean; outcome: string | null }>();
    for (const r of anchorRows) {
      anchorByInit.set(`${r.team}/${r.slug}`, { flow: r.flow, closed: r.closed, outcome: r.outcome });
    }
    // A document group with no `zz.initiative` row yet — the reconcile lag Q2/E of the schema
    // review names — reads as open with no declared flow, the same answer this route gave every
    // initiative before this row existed at all.
    const noAnchor = { flow: null as string | null, closed: false, outcome: null as string | null };

    const { rows } = scope.kind !== "platform"
      ? await db.query<ListRow>(
      `select t.slug as team_slug, i.slug as initiative, d.path, d.type, d.status,
              a.email as approved_by, (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = d.id and l.from_revision = r.revision
                               and l.kind = 'supports') as supports,
              (select count(*) from zz.doc_revision r2
                where r2.doc_id = d.id and r2.approved_by is not null)::text as approvals,
              case when i.closed_at is not null and d.status <> 'approved' and d.path <> 'handover.md'
                         and coalesce(i.flow, '') <> '' and d.approved_revision is not null and d.updated_at > i.closed_at
                         and (i.outcome <> 'abandoned'
                              or (select x.fields->>'outcome' from zz.doc_revision x
                                   where x.doc_id = d.id and x.revision = d.approved_revision) is not null)
                   then d.current_version end as correction,
              to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         left join zz.principal a on a.id = r.approved_by
        where i.slug <> '_knowledge' and t.slug = $1
        order by t.slug, i.slug, d.path`, [scope.slug])
      : want !== null
      ? await db.query<ListRow>(
      `select t.slug as team_slug, i.slug as initiative, d.path, d.type, d.status,
              a.email as approved_by, (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = d.id and l.from_revision = r.revision
                               and l.kind = 'supports') as supports,
              (select count(*) from zz.doc_revision r2
                where r2.doc_id = d.id and r2.approved_by is not null)::text as approvals,
              case when i.closed_at is not null and d.status <> 'approved' and d.path <> 'handover.md'
                         and coalesce(i.flow, '') <> '' and d.approved_revision is not null and d.updated_at > i.closed_at
                         and (i.outcome <> 'abandoned'
                              or (select x.fields->>'outcome' from zz.doc_revision x
                                   where x.doc_id = d.id and x.revision = d.approved_revision) is not null)
                   then d.current_version end as correction,
              to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         left join zz.principal a on a.id = r.approved_by
        where i.slug <> '_knowledge' and t.slug = $1
        order by t.slug, i.slug, d.path`, [want])
      : await db.query<ListRow>(
      `select t.slug as team_slug, i.slug as initiative, d.path, d.type, d.status,
              a.email as approved_by, (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = d.id and l.from_revision = r.revision
                               and l.kind = 'supports') as supports,
              (select count(*) from zz.doc_revision r2
                where r2.doc_id = d.id and r2.approved_by is not null)::text as approvals,
              case when i.closed_at is not null and d.status <> 'approved' and d.path <> 'handover.md'
                         and coalesce(i.flow, '') <> '' and d.approved_revision is not null and d.updated_at > i.closed_at
                         and (i.outcome <> 'abandoned'
                              or (select x.fields->>'outcome' from zz.doc_revision x
                                   where x.doc_id = d.id and x.revision = d.approved_revision) is not null)
                   then d.current_version end as correction,
              to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         left join zz.principal a on a.id = r.approved_by
        where i.slug <> '_knowledge'
        order by t.slug, i.slug, d.path`);
    const byInit = new Map<string, typeof rows>();
    for (const r of rows) {
      // "/" as the separator, because a team slug cannot contain one (TEAM_SLUG is [a-z0-9_-]),
      // so the split below is unambiguous. A NUL byte here makes grep skip the file as binary.
      const key = `${r.team_slug}/${r.initiative}`;
      const got = byInit.get(key);
      if (got) got.push(r); else byInit.set(key, [r]);
    }
    const initiatives = [...byInit.entries()].map(([key, docs]) => {
      const cut = key.indexOf("/");
      const teamSlug = key.slice(0, cut), slug = key.slice(cut + 1);
      const anchor = anchorByInit.get(key) ?? noAnchor;
      return {
        team: teamSlug, slug,
        flow: anchor.flow,
        // `approvals`, not revisions: a seal lands on a revision, and a revision nobody
        // approved carries none. What each row counts is the sealed revisions of ONE document,
        // so the initiative's total is their sum — not the document count, which would report
        // a document approved twice as one approval.
        documents: docs.length,
        approvals: docs.reduce((n, d) => n + Number(d.approvals ?? 0), 0),
        updated: docs.reduce((a, d) => (d.updated_at > a ? d.updated_at : a), ""),
        // Whoever approved something is the person the work belongs to. There is no owner
        // column, and the first document's author is whoever typed first, not who signed.
        stakeholder: docs.map((d) => d.approved_by).find(Boolean) ?? null,
        ...stageOf(docs, anchor.flow, { closed: anchor.closed, outcome: anchor.outcome },
                   factsByInit.get(key) ?? {}),
      };
    }).sort((a, b) => b.updated.localeCompare(a.updated));
    /* What the console's alert bell and its "Waiting on you" panel ask: the gate documents a person
     * can sign today — written, not yet approved, on an open initiative.
     *
     * DELIBERATE: its own projection rather than the whole list. The bell sits in the frame every
     * console page renders, so this read happens on every page, and the full list carries a stepper
     * and a gate list per initiative for every initiative the caller may read — kilobytes, to draw
     * a badge that is usually empty. This answers it in a row per open gate.
     *
     * `written`, because a gate nobody has drafted is waiting on the agent and not on a person, and
     * `!passed`, which is the approval itself.
     *
     * A closed initiative waits on a person in one case: a correction of an approved document, a
     * draft until somebody approves it again — the same `await_approval` initiative_status
     * routes it to. Its gates are otherwise settled, so that document is the one row it adds. */
    const waiting = initiatives
      .flatMap((i) => {
        const where = { team: i.team, slug: i.slug, updated: i.updated, stage: i.stage, at: i.at, of: i.of };
        if (i.closed) {
          return i.correction
            ? [{ id: `${i.team}/${i.slug}/${i.correction.path}`,
                 gate: `${i.correction.path.replace(/\.md$/, "")} correction v${i.correction.version}`, ...where }]
            : [];
        }
        return i.gates
          .filter((g) => g.written && !g.passed)
          // The verb is the platform's ("approve spec"); the reader is shown the noun.
          .map((g) => ({ id: `${i.team}/${i.slug}/${g.name}`, gate: g.name.replace(/^approve /, ""), ...where }));
      })
      .sort((a, b) => b.updated.localeCompare(a.updated));
    res.json({ waiting });
  });

  /* The list, unless the bell asks for its own projection.
   * DELIBERATE: two wrappers on one path. The bell keeps the caller's scope as it always read it; the
   * list resolves none, because nothing a request names may move it off the active team. */
  app.get("/api/console/initiatives", (req, res) => (req.query.waiting === "1" ? bell : list)(req, res));
}
