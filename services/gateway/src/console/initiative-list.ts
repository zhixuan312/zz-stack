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
 *              last touched, and how many of them had been opened by the end of the last whole week,
 *              closed since or not
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
 * DELIBERATE: no backticks in the comments this module adds. check:sql reads the file as text, and a
 * lone backtick in a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's InitiativeList in src/lib/work-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/work-initiatives.ts, which checks/console-work-initiatives.ts compares this
 * route's answer with, key set by key set.
 */
import { OUTCOMES } from "@zz/contracts";
import type { Express } from "express";
import type { Mcp } from "@zz/mcp-client";

import { coreFor } from "../core-as-caller.js";
import { platformDb } from "../db.js";
import type { Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { pendingRevisions } from "./pending.js";
import { BAD_PAGE, NO_TEAM, platformPublic, stageOf, type StageDoc, ZZ_TZ } from "./shared.js";
import { closuresByWeek, grainFor, lastWholeWeek, periodsOf, type ClosureWeek } from "./work-figures.js";

/** Where an initiative goes next, as initiative_status answers it, its keys spelled as the console's. */
type NextMove = { action: string; stage: string | null; document: string | null; waitingOn: string | null; why: string };
export type State = "open" | "waiting" | "quiet" | (typeof OUTCOMES)[number];
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
/** An initiative's state at `asOfMs`, the one rule the list and the initiative's own page answer: its outcome once
 *  closed; open, waiting while a revision of it waits for approval, quiet when it was last touched QUIET_AFTER or more
 *  before, and open otherwise. */
export function stateOf(a: { outcome: string | null; closed: boolean; touchedMs: number }, waiting: boolean, asOfMs: number): State {
  if (a.closed && a.outcome !== null) return a.outcome as State;
  return waiting ? "waiting" : asOfMs - a.touchedMs >= QUIET_AFTER ? "quiet" : "open";
}

/** The most names one initiative_status call answers. */
const BATCH = 10;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The query's filters and page, each given at most once, or the sentence a 400 says. Work's prepared
 *  queries take the same filters and page, so they read them here too. */
export function listParams(query: Record<string, unknown>): ListParams | string {
  for (const name of ["state", "flow", "q", "limit", "offset"]) {
    if (query[name] !== undefined && typeof query[name] !== "string") return "each filter and the page are given at most once";
  }
  const text = (name: string): string | null => (query[name] as string | undefined) ?? null;
  const state = text("state");
  if (state !== null && !STATES.includes(state as State)) return `state must be one of ${STATES.join(", ")}`;
  const limit = Number(text("limit") ?? 10), offset = Number(text("offset") ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    return BAD_PAGE;
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
    const state = stateOf({ outcome, closed, touchedMs: touched }, waiting.has(a.slug), asOfMs);
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
  /** The list, for the team the caller's identity acts for and no other. A request for the waiting
   *  gates is answered as an address that names nothing: the bell's projection is gone, and what waits
   *  on a person is Home's and Approvals'. */
  app.get("/api/console/initiatives", platformPublic("the initiatives", async (req, res, { activeTeam }) => {
    if (req.query.waiting !== undefined) {
      res.status(404).json({ error: "no waiting projection: what waits on you is on Home and Approvals" });
      return;
    }
    if (activeTeam === null) {
      res.status(400).json({ error: NO_TEAM });
      return;
    }
    const params = listParams(req.query as Record<string, unknown>);
    if (typeof params === "string") { res.status(400).json({ error: params }); return; }
    // The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it.
    res.json(await initiativeList(activeTeam, params, iso(Math.ceil(Date.now() / 1000) * 1000), coreFor(req)));
  }));
}
