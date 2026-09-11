/**
 * watch-results — alert on results getting worse, not on the service being up.
 *
 *   zz-tool watch-results [--window '7 days'] [--psql '<command>']
 *                         [--health http://cred-proxy:8000/health]
 *
 * A liveness check answers "is the gateway answering", and the gateway is almost always
 * answering. The failures that actually cost something look nothing like an outage: five
 * initiatives stuck on the same gate, a refusal class that tripled this week, a block whose
 * latency doubled, a team that has produced nothing for seven days. Every one of those is
 * invisible to a health endpoint and visible in data the platform is already writing.
 *
 * NO NEW COLLECTION. Everything here reads zz.event and zz.doc, which have been recording
 * this all along. What was missing is something that reads them on a schedule and says so
 * when the numbers move the wrong way.
 *
 * NOT ERRORING IS NOT SUCCEEDING, and this tool is the first thing that rule applies to. A
 * collector nobody scheduled does not fail — it quietly produces "nothing wrong today" every
 * day, which is more dangerous than being down, because being down gets noticed. So an empty
 * window is an ALERT here, never an all-clear: if this cannot see any activity at all, the
 * most likely explanation is that it is looking at the wrong place, not that a platform with
 * users had a silent week.
 *
 * Exit status is the interface: 0 nothing worsened, 1 something did, 2 it could not tell.
 * Cron reads that; a human reads the lines above it.
 */
import { execFileSync } from "node:child_process";

import { refusalClass } from "@zz/contracts";

import { parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";

/** How much worse a number has to get before it is worth waking somebody for. */
const WORSE = 2;
/** Below this, a doubling is noise: 1 refusal becoming 2 is not a trend. */
const FLOOR = 5;

interface EventRow {
  ts: string; team_slug: string | null; subject: string; detail: Record<string, unknown>;
}
interface DocRow {
  team_slug: string; initiative: string; path: string; status: string;
  outcome: string | null; updated_at: string;
}


const median = (ns: number[]): number => {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function main(): number {
  const { flags } = parseArgs(process.argv.slice(2));
  const psql = flags.get("psql") || DEFAULT_PSQL;
  const window = flags.get("window") || "7 days";

  // This window and the one before it, so "worse" is measured against this platform's own
  // recent normal rather than against a number somebody guessed once.
  const evNow = psqlRows<EventRow>(psql,
    "select ts, team_slug, subject, detail" +
    "  from zz.event where kind = 'tool_call' and ts > now() - (:'w')::interval", { w: window });
  const evPrev = psqlRows<EventRow>(psql,
    "select ts, team_slug, subject, detail" +
    "  from zz.event where kind = 'tool_call'" +
    "   and ts <= now() - (:'w')::interval and ts > now() - 2 * (:'w')::interval", { w: window });
  const docs = psqlRows<DocRow>(psql,
    "select team_slug, initiative, path, status, outcome, updated_at from zz.doc", {});

  const alerts: string[] = [];

  // PROVENANCE THE DATABASE REFUSED. events.ts writes those to a file and counts them, and
  // /health reports the count — with a comment saying "a monitor already polls this
  // endpoint; that is where it belongs". Nothing in this repository polls it: the release
  // checks /health once and never again. So the one signal saying the audit record has
  // holes in it was reported to nobody, which is the exact shape principle 12 names — the
  // file exists, the count exists, and not erroring is not succeeding.
  //
  // Read here because this IS the monitor now. Failing to reach it is not an alert: this
  // tool may be run from a checkout with no gateway on the network, and inventing an alarm
  // out of "I could not ask" is how a monitor teaches people to ignore it.
  const health = flags.get("health") || "http://cred-proxy:8000/health";
  try {
    const raw = execFileSync("curl", ["-s", "-m", "10", health], { encoding: "utf8" });
    const body = JSON.parse(raw) as { stranded_events?: { count: number; last: string | null; file: string } };
    const st = body.stranded_events;
    if (st?.count) {
      alerts.push(`${st.count} events could not be written to the database and are sitting in ` +
                  `${st.file} (last ${st.last ?? "unknown"}) — the audit record has holes`);
    }
  } catch { /* no gateway reachable from here: not something to wake anybody for */ }

  // The check on this tool itself, first. Silence is the failure mode a monitor has, and a
  // monitor that reports "all clear" on an empty query has told you nothing while sounding
  // like it told you something.
  if (!evNow.length && !evPrev.length) {
    console.log(`\n  CANNOT TELL: no tool calls recorded in the last ${window}, or the ${window} before it.\n`);
    console.log("  A platform with users does not have two silent windows in a row. Far more likely:");
    console.log("  this is pointed at the wrong database, or nothing is writing telemetry.");
    console.log("  Treated as a failure deliberately — 'no data' must never read as 'no problems'.\n");
    return 2;
  }

  // 1. A refusal class that got worse. The class, not the raw text: two initiatives failing
  //    the same rule are one problem and read as two until they are grouped.
  const classes = (rows: EventRow[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of rows) {
      if (!e.detail.refusal) continue;
      const c = refusalClass(String(e.detail.refusal));
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  };
  const now = classes(evNow), prev = classes(evPrev);
  for (const [c, n] of [...now].sort((a, b) => b[1] - a[1])) {
    const before = prev.get(c) ?? 0;
    if (n >= FLOOR && n >= (before || 1) * WORSE) {
      alerts.push(`refusals up: ${before} to ${n} - ${c.slice(0, 120)}`);
    }
  }

  // 2. A block whose latency doubled. Median, because one slow call is not a trend and a
  //    mean is one timeout away from saying so.
  const msBy = (rows: EventRow[]): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const e of rows) {
      const surface = e.subject.split(":")[0];
      if (typeof e.detail.ms !== "number") continue;
      m.set(surface, [...(m.get(surface) ?? []), e.detail.ms]);
    }
    return m;
  };
  const mNow = msBy(evNow), mPrev = msBy(evPrev);
  for (const [surface, ns] of mNow) {
    const before = median(mPrev.get(surface) ?? []);
    const after = median(ns);
    if (ns.length >= FLOOR && before > 0 && after >= before * WORSE) {
      alerts.push(`${surface} got slower: median ${before}ms to ${after}ms over ${ns.length} calls`);
    }
  }

  // 3. Documents stuck at a gate. A draft nobody approved is normal for a day and a question
  //    after a fortnight — and it is the shape of failure this platform is most prone to,
  //    because a gate waiting on a person looks identical to one forgotten.
  //
  //    THE OUTCOME IS THE INITIATIVE'S, NOT THE DOCUMENT'S. Only the closing document carries
  //    it, so skipping rows that have one skipped exactly one file per initiative and left
  //    every other document of a CLOSED initiative in the count. Those never change again —
  //    which made this the one alert that, once raised, fires identically every run forever,
  //    the precise way a monitor teaches the people reading it to stop.
  const closedInitiatives = new Set(
    docs.filter((d) => d.outcome).map((d) => `${d.team_slug} ${d.initiative}`));
  const stuck = new Map<string, number>();
  for (const d of docs) {
    if (closedInitiatives.has(`${d.team_slug} ${d.initiative}`)) continue;
    if (d.status !== "draft") continue;
    const age = (Date.now() - Date.parse(d.updated_at)) / 86_400_000;
    if (age > 14) stuck.set(d.team_slug, (stuck.get(d.team_slug) ?? 0) + 1);
  }
  for (const [team, n] of stuck) {
    if (n >= 3) alerts.push(`${team}: ${n} documents have sat in draft for over a fortnight`);
  }

  // 4. A team that has gone quiet. Not an error anywhere — which is the point of watching it.
  const active = new Set(evNow.map((e) => e.team_slug).filter(Boolean) as string[]);
  const wasActive = new Set(evPrev.map((e) => e.team_slug).filter(Boolean) as string[]);
  for (const team of wasActive) {
    if (!active.has(team)) alerts.push(`${team} was working last ${window} and has done nothing this one`);
  }

  if (!alerts.length) {
    console.log(`\n  Nothing got worse over the last ${window}, measured against the ${window} before it.`);
    console.log(`  (${evNow.length} calls seen, so this is a real look rather than an empty one.)\n`);
    return 0;
  }

  console.log(`\n  Results worsened over the last ${window}:\n`);
  for (const a of alerts) console.log(`    - ${a}`);
  console.log(`\n  ${evNow.length} calls this window, ${evPrev.length} the window before.\n`);
  return 1;
}

process.exit(main());
