/**
 * What needs attention on Status: issue instances counted first, then projected for the reader, then
 * cut to five rows, with what the cut left out counted by kind.
 *
 *   bugs        one while a real report is open; critical when one blocks work
 *   door        one per door with a fault day today, so far: tool failures at 1% of its calls or more
 *   evaluation  one while a finding has waited 14 days or more for a decision
 *   approvals   one per team with a revision waiting for approval (pending.ts) 14 days or more
 *   drift       one per latency whose last comparable week is at least twice its first, the first not
 *               zero; comparable means complete and of 30 calls or more
 *
 * Rows sort critical before warning, then by kind in that order, then the oldest first, then by an
 * internal key (a door, a team's id, a measure's key) that no answer carries. A member's approvals
 * fold into one row that names no team and links nowhere. A check that could not be read is named in
 * `unavailableKinds`: the total is then null, since nothing can be said of what it would have found,
 * and the headline says so. The verdict is about the checks recorded, never about whether anything
 * can be reached now.
 *
 * COUPLED: the console's `Needs` in src/lib/platform-shapes.ts, and its fake answer in
 * scripts/fake-gateway/platform-status.ts.
 */
import { platformDb } from "../db.js";
import type { PeriodFigure } from "./figures.js";
import type { PendingRevision } from "./pending.js";
import type { realReports } from "./platform-bugs.js";
import type { StatusMeasure } from "./platform-measures.js";

type NeedKind = "bugs" | "evaluation" | "approvals" | "drift" | "door";
type Need = {
  kind: NeedKind; title: string; detail: string;
  instanceCount: number; oldestAt: string | null;
  href: string | null; tone: "critical" | "warning";
};
export type Needs = {
  state: "complete" | "partial" | "unavailable"; rows: Need[];
  total: number | null; knownCount: number;   // instances found by the checks that completed; equal to total when all did
  unavailableKinds: NeedKind[];
  overflowByKind: Partial<Record<NeedKind, number>>;
  headline: string;
};

/** A door's today, so far, when its tool failures are a fault day's share of its calls. */
export type DoorToday = { door: string; calls: number; toolFailures: number; firstFailureMs: number | null };

/** The destinations already released, each a page a link may open; a row whose destination is not
 *  among them links nowhere. Bugs and Evaluation join when their pages ship, Usage (door, drift)
 *  with Phase 2. */
const RELEASED: ReadonlySet<string> = new Set(["/teams"]);

/** How long a finding or a revision may wait before it needs somebody. */
const WAIT_MS = 14 * 86_400_000;
const ROWS = 5;
const KINDS: readonly NeedKind[] = ["bugs", "door", "evaluation", "approvals", "drift"];

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const count = (n: number): string => n.toLocaleString("en-GB");
const counted = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The local date an instant falls on, as a sentence prints it: `28 Sep`. */
function day(instant: string, timezone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(instant));
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

/** Where a row links: `path` when the destination it belongs to is released, else nowhere. */
const link = (destination: string, path = destination): string | null => (RELEASED.has(destination) ? path : null);

/** The findings that have waited 14 days or more for a decision, as `waiting` on Evaluation counts
 *  them: deferred defects and unknowns not superseded. */
export async function evaluationWaiting(asOfMs: number): Promise<{ waiting: number; oldestMs: number | null }> {
  const row = (await platformDb().query<{ waiting: number; oldest_ms: number | null }>(
    `select count(*)::int as waiting, (extract(epoch from min(f.created_at)) * 1000)::float8 as oldest_ms
       from zz.eval_finding f
      where f.decision = 'deferred' and f.kind in ('defect', 'unknown') and f.superseded_by is null
        and f.created_at <= $1::timestamptz`, [new Date(asOfMs - WAIT_MS).toISOString()])).rows[0];
  return { waiting: row.waiting, oldestMs: row.oldest_ms };
}

/** What each check read; null for a check that could not be read. */
type NeedsInput = {
  superadmin: boolean; asOfMs: number; timezone: string;
  reports: Awaited<ReturnType<typeof realReports>> | null;
  doors: DoorToday[] | null;
  evaluation: { waiting: number; oldestMs: number | null } | null;
  pending: PendingRevision[] | null;
  latency: [StatusMeasure, StatusMeasure] | null;
};

/** One instance, with the key that orders it among its kind and is never answered. */
type Instance = Need & { key: string };

/** The latency that has at least doubled: its last comparable week against its first. */
function drift(m: StatusMeasure, label: string, timezone: string): Instance | null {
  const comparable = m.weeks.filter((w: PeriodFigure) => w.window.complete && w.figure.why === null);
  const first = comparable[0], last = comparable.at(-1);
  if (!first || !last || last === first || first.figure.value! <= 0 || last.figure.value! < 2 * first.figure.value!) return null;
  return {
    kind: "drift", key: m.key, tone: "warning", instanceCount: 1, oldestAt: last.window.from, href: link("/platform/usage"),
    title: `${label} has at least doubled`,
    detail: `${count(last.figure.value!)} ms in the week of ${day(last.window.from, timezone)}, against ` +
      `${count(first.figure.value!)} ms in the week of ${day(first.window.from, timezone)}`,
  };
}

/** Every instance the completed checks found, and the kinds whose check could not be read. */
function instances(input: NeedsInput): { found: Instance[]; unavailable: NeedKind[] } {
  const found: Instance[] = [];
  const unavailable: NeedKind[] = [];
  if (input.reports === null) unavailable.push("bugs");
  else {
    const open = input.reports.filter((r) => r.status === "open");
    if (open.length) {
      const blocking = open.filter((r) => r.impact === "blocks_work").length;
      found.push({
        kind: "bugs", key: "bugs", tone: blocking ? "critical" : "warning", instanceCount: 1,
        oldestAt: iso(Math.min(...open.map((r) => r.reportedMs))), href: link("/platform/bugs"),
        title: "Bug reports are open",
        detail: `${counted(open.length, "open report", "open reports")}, ${count(blocking)} blocking work`,
      });
    }
  }
  if (input.doors === null) unavailable.push("door");
  else {
    for (const d of input.doors) {
      if (d.calls === 0 || d.toolFailures * 100 < d.calls) continue;
      found.push({
        kind: "door", key: d.door, tone: "critical", instanceCount: 1,
        oldestAt: d.firstFailureMs === null ? null : iso(d.firstFailureMs), href: link("/platform/usage"),
        title: `The ${d.door} door has a fault day today, so far`,
        detail: `${counted(d.toolFailures, "tool failure", "tool failures")} in ${counted(d.calls, "call", "calls")} so far today`,
      });
    }
  }
  if (input.evaluation === null) unavailable.push("evaluation");
  else if (input.evaluation.waiting > 0) {
    found.push({
      kind: "evaluation", key: "evaluation", tone: "warning", instanceCount: 1,
      oldestAt: input.evaluation.oldestMs === null ? null : iso(input.evaluation.oldestMs), href: link("/platform/evaluation"),
      title: "Evaluation findings are waiting for a decision",
      detail: `${counted(input.evaluation.waiting, "finding has", "findings have")} waited 14 days or more for a decision`,
    });
  }
  if (input.pending === null) unavailable.push("approvals");
  else {
    const late = input.pending.filter((p) => p.presentedMs <= input.asOfMs - WAIT_MS);
    for (const teamId of [...new Set(late.map((p) => p.teamId))]) {
      const mine = late.filter((p) => p.teamId === teamId);
      found.push({
        kind: "approvals", key: teamId, tone: "warning", instanceCount: 1,
        oldestAt: iso(Math.min(...mine.map((p) => p.presentedMs))), href: link("/teams", `/teams/${mine[0].team}`),
        title: `Approvals are waiting in ${mine[0].team}`,
        detail: `${counted(mine.length, "revision was", "revisions were")} presented 14 days ago or more and not approved`,
      });
    }
  }
  if (input.latency === null) unavailable.push("drift");
  else {
    for (const d of [drift(input.latency[0], "Median call duration", input.timezone),
                     drift(input.latency[1], "95th percentile call duration", input.timezone)]) if (d) found.push(d);
  }
  return { found, unavailable };
}

/** Critical first, then the kinds in their order, the oldest first, then the internal key. */
function byAttention(a: Instance, b: Instance): number {
  return (a.tone === b.tone ? 0 : a.tone === "critical" ? -1 : 1)
    || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)
    || (a.oldestAt ?? "￿").localeCompare(b.oldestAt ?? "￿")
    || a.key.localeCompare(b.key);
}

/** The headline the page leads with: for the superadmin what needs them, for a member what is known
 *  and open; with a check unavailable, what is known and that it is not everything. */
function headline(superadmin: boolean, total: number | null, known: number, allUnavailable: boolean): string {
  if (allUnavailable) return "Status checks unavailable";
  if (total === null) return `${counted(known, "known issue", "known issues")}; some checks unavailable`;
  if (total === 0) return superadmin ? "Nothing needs you" : "No known open issues";
  return superadmin ? `${counted(total, "thing needs", "things need")} you` : `${counted(total, "thing is", "things are")} known and open`;
}

/** What needs attention, as the reader may read it. */
export function needsOf(input: NeedsInput): Needs {
  const { found, unavailable } = instances(input);
  found.sort(byAttention);
  let shown: Instance[] = found;
  if (!input.superadmin) {
    // A member reads how many teams wait, never which: one row in the place the first of them held.
    const waiting = found.filter((n) => n.kind === "approvals");
    const [longest] = waiting;
    if (longest) {
      const folded: Instance = {
        kind: "approvals", key: "approvals", tone: "warning", instanceCount: waiting.length, oldestAt: longest.oldestAt, href: null,
        title: `Approvals are waiting in ${counted(waiting.length, "team", "teams")}`,
        detail: `${counted(waiting.length, "team has", "teams have")} a revision presented 14 days ago or more and not approved`,
      };
      shown = found.flatMap((n) => (n.kind !== "approvals" ? [n] : n === longest ? [folded] : []));
    }
  }
  const overflowByKind: Partial<Record<NeedKind, number>> = {};
  for (const n of shown.slice(ROWS)) overflowByKind[n.kind] = (overflowByKind[n.kind] ?? 0) + n.instanceCount;
  const known = found.length;
  const total = unavailable.length ? null : known;
  const allUnavailable = unavailable.length === KINDS.length;
  return {
    state: allUnavailable ? "unavailable" : unavailable.length ? "partial" : "complete",
    rows: shown.slice(0, ROWS).map(({ key: _key, ...need }) => need),
    total, knownCount: known,
    unavailableKinds: KINDS.filter((k) => unavailable.includes(k)),
    overflowByKind,
    headline: headline(input.superadmin, total, known, allUnavailable),
  };
}
