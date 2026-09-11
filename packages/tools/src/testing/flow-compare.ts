/**
 * flow-compare — the same metrics across flows and across teams.
 *
 *   zz-tool testing/flow-compare [--since '90 days'] [--psql '<command>']
 *
 * "Which methodology costs less" is a question no single run can answer, and no per-flow
 * report can either: sdlc's own numbers say whether sdlc got faster, never whether sm would
 * have been cheaper for the same work. Answering it needs one set of metrics computed the
 * same way over every flow, which is possible here for one specific reason.
 *
 * THE ENVELOPE DOES NOT FORK. A flow declares its own documents, its own headings and its
 * own gates, but `flow`, `type`, `status` and `outcome` are the same words in every one of
 * them — so "how many initiatives were accepted" and "how many were reworked" are answerable
 * across flows without asking any flow to agree to be measured. That rule usually gets
 * explained as consistency; this tool is what it was actually for.
 *
 * Built before the samples exist, deliberately. A metric defined after seeing the numbers is
 * a metric chosen to say something, and this comparison is only worth having if nobody
 * picked it knowing the answer. It reports honestly on thin data: a flow with two
 * initiatives is named as such rather than ranked against one with fifty.
 *
 * Reads the platform's own record — zz.doc for what exists and how it ended, zz.event for
 * what the work cost. Nothing here is self-reported by an agent.
 */
import { parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";

const COMPARABLE = 5;

interface DocRow {
  team_slug: string; initiative: string; flow: string; path: string;
  type: string; status: string; outcome: string | null; updated_at: string;
}
interface EventRow {
  ts: string; team_slug: string | null; surface: string; tool: string;
  ok: boolean | null; refusal: string | null; ms: number | null;
  ids: Record<string, string> | null;
}


interface Cell {
  team: string;
  flow: string;
  initiatives: Set<string>;
  closed: Map<string, number>;
  revisions: Map<string, number>;
  refusals: number;
  calls: number;
}

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

function main(): number {
  const { flags } = parseArgs(process.argv.slice(2));
  const psql = flags.get("psql") || DEFAULT_PSQL;
  const since = flags.get("since") || "90 days";

  const docs = psqlRows<DocRow>(psql,
    "select team_slug, initiative, flow, path, type, status, outcome, updated_at" +
    "  from zz.doc where updated_at > now() - (:'since')::interval", { since });

  const events = psqlRows<EventRow>(psql,
    "select ts, team_slug, surface, tool, ok, refusal, ms, ids from zz.event" +
    " where kind = 'tool_call' and ts > now() - (:'since')::interval", { since });

  // A document knows its flow; an event does not. The initiative is the join, and it is on
  // the event because `initiative` is one of the identifier arguments telemetry keeps. An
  // event whose initiative is not in the document index is DROPPED rather than guessed at:
  // an unattributed call is not evidence about any flow, and counting it somewhere would
  // make the cheapest-looking flow the one whose calls were hardest to attribute.
  const flowOf = new Map<string, { team: string; flow: string }>();
  for (const d of docs) {
    if (d.flow) flowOf.set(`${d.team_slug} ${d.initiative}`, { team: d.team_slug, flow: d.flow });
  }

  const cells = new Map<string, Cell>();
  const cell = (team: string, flow: string): Cell => {
    const k = `${team} ${flow}`;
    let c = cells.get(k);
    if (!c) {
      c = { team, flow, initiatives: new Set(), closed: new Map(), revisions: new Map(),
            refusals: 0, calls: 0 };
      cells.set(k, c);
    }
    return c;
  };

  for (const d of docs) {
    if (!d.flow) continue;
    const c = cell(d.team_slug, d.flow);
    c.initiatives.add(d.initiative);
    // Only the closing document carries an outcome, so this counts initiatives, not files.
    if (d.outcome) c.closed.set(d.outcome, (c.closed.get(d.outcome) ?? 0) + 1);
  }

  let unattributed = 0;
  for (const e of events) {
    const ids = e.ids ?? {};
    const initiative = ids.initiative || (ids.path ?? "").split("/")[0];
    if (!initiative || !e.team_slug) { unattributed += 1; continue; }
    const owner = flowOf.get(`${e.team_slug} ${initiative}`);
    if (!owner) { unattributed += 1; continue; }
    const c = cell(owner.team, owner.flow);
    c.calls += 1;
    if (e.refusal) c.refusals += 1;
    // A revision is a person's words CHANGING a document. A refused revise_document changed
    // nothing — and it is already in the refusal column, so counting it here charged the same
    // event to rework as well, and the flow that refuses most looked like the flow reworked
    // most. `ok` is on every telemetry row; evolve-report has always read it.
    if (e.tool === "revise_document" && e.ok) {
      c.revisions.set(initiative, (c.revisions.get(initiative) ?? 0) + 1);
    }
  }

  const rows = [...cells.values()].sort((a, b) =>
    a.flow.localeCompare(b.flow) || a.team.localeCompare(b.team));

  if (!rows.length) {
    // Non-zero: a comparison with nothing in it is not a passing comparison. A pipeline
    // asking "is there anything to compare yet" gets an answer it can branch on, rather
    // than a success that looks like agreement.
    console.log(`\n  No initiative in the last ${since} carries a flow. Nothing to compare.\n`);
    return 1;
  }

  console.log(`\n  Flows and teams, last ${since}\n`);
  console.log("  flow                 team                 inits  closed  accepted  rework/init  refusal%  calls");
  console.log(`  ${"-".repeat(100)}`);
  for (const c of rows) {
    const inits = c.initiatives.size;
    const closed = sum([...c.closed.values()]);
    const accepted = c.closed.get("accepted") ?? 0;
    const rework = inits ? (sum([...c.revisions.values()]) / inits).toFixed(2) : "-";
    const refusal = c.calls ? `${((c.refusals / c.calls) * 100).toFixed(1)}%` : "-";
    console.log(
      `  ${c.flow.padEnd(21)}${c.team.padEnd(21)}${String(inits).padStart(5)}` +
      `${String(closed).padStart(8)}${String(accepted).padStart(10)}` +
      `${rework.padStart(13)}${refusal.padStart(10)}${String(c.calls).padStart(7)}`);
  }

  // Thin samples are NAMED, not ranked. A flow with two initiatives beside one with fifty is
  // not a comparison, and printing both in one table without saying so invites exactly the
  // reading the numbers cannot support.
  const thin = rows.filter((c) => c.initiatives.size < COMPARABLE);
  if (thin.length) {
    console.log(`\n  Under ${COMPARABLE} initiatives, so not comparable: ` +
      thin.map((c) => `${c.flow}/${c.team} (${c.initiatives.size})`).join(", "));
    console.log("  Those rows are a record, not a ranking.");
  }

  const byFlow = new Map<string, Cell[]>();
  for (const c of rows.filter((x) => x.initiatives.size >= COMPARABLE)) {
    byFlow.set(c.flow, [...(byFlow.get(c.flow) ?? []), c]);
  }
  if (byFlow.size > 1) {
    console.log("\n  Across flows, on comparable samples only:");
    for (const [flow, cs] of [...byFlow].sort()) {
      const inits = sum(cs.map((c) => c.initiatives.size));
      const rework = sum(cs.map((c) => sum([...c.revisions.values()])));
      const calls = sum(cs.map((c) => c.calls));
      const refusals = sum(cs.map((c) => c.refusals));
      console.log(`    ${flow.padEnd(20)} ${inits} initiatives - ` +
        `${(rework / inits).toFixed(2)} revisions each - ` +
        `${calls ? ((refusals / calls) * 100).toFixed(1) : "0.0"}% of calls refused`);
    }
  } else if (byFlow.size === 1) {
    console.log(`\n  Only one flow has ${COMPARABLE}+ initiatives, so there is nothing to compare it against yet.`);
  }

  // Said out loud, because a silently dropped denominator is how a comparison lies.
  if (unattributed) {
    console.log(`\n  ${unattributed} tool calls named no initiative this index knows, and are in no column.`);
  }
  console.log();
  return 0;
}

process.exit(main());
