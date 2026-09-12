/**
 * tool-report — what the platform's tools actually did, from the platform's own record.
 *
 * Reads `zz.event` where kind = 'tool_call' and answers three questions the smoke suite
 * cannot: which tools are being refused, why, and how long they take. The suite scores a
 * SCENARIO — one boolean for ten minutes of work — so a run that fails at the first gate and
 * a run that fails at the last are the same number. One scenario produces fifty to a hundred
 * tool calls, and each one is an outcome with a reason attached.
 *
 * The reasons are the platform's own refusal messages, written to say which rule was broken.
 * Grouped, they are the shortest description of where a flow actually stalls.
 *
 *   npm run tool-report                                     # last 24h, on the host
 *   npm run tool-report -- --since 2h --surface core
 *   npm run tool-report -- --actor smoke_eval@example.com   # one evaluation run
 *   npm run tool-report -- --compare last-run.json          # what moved since then
 *   npm run tool-report -- --json > report.json             # the same, for tooling
 *   npm run tool-report -- --save runs/                     # keep this one, named to sort
 *   npm run tool-report -- --ledger runs/                   # every saved run, by refusal class
 *   npm run tool-report -- --fail-under 90                  # non-zero below that accepted rate
 *
 * Run it on the deployment host: it reads the platform database through the compose project,
 * the same way backup.sh and issue-first-pat.sh do. --psql overrides that for anywhere else.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { refusalClass } from "@zz/contracts";

import { die, optional, parseArgs } from "../lib/cli.js";
import { teachesTheRule } from "../lib/refusal.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";
import { localStamp } from "../lib/shell.js";


// R6 of the building-block contract: "validation errors in prose that teach the rule — no
// silent coercion, no bare status codes". A refusal that names a status and stops is the
// violation, and it is visible from here: the agent gets nothing to change, so it retries the
// same call with the same arguments until it gives up. Measured on a real run,
// one block's write tool was refused on most calls with "Request failed with status
// code 422" and nothing else — the same gap this contract's appendix recorded on 2026-08-20.
//
// The judgement lives in lib/refusal.ts, because block-conformance asks the same question of
// a block's answer and the two used to disagree about it.

/** A row of zz.tool_call. Flat columns, because the table has them — this was a `subject`
 * string to split and a `detail` bag to reach into, and every reader spelled the reaching-in
 * slightly differently. */
interface CallRow {
  ts: string;
  subject: string;                       // `<surface>:<tool>`

  /* ── COLUMNS: the three dimensions and the outcome ────────────────────────────
   * Which flow, which of its steps and which revision of that step; which block and its own
   * account of itself; whether the call worked and, when it did not, the platform's own
   * sentence saying which rule was broken. These are columns because somebody groups by them.
   *
   * `initiative` and `team_slug` are the JOIN KEYS to zz.doc and zz.decision — without them a
   * refusal cannot be connected to the document it was made for or the claim it was testing,
   * which is why the reconciliation between prediction and outcome had almost nothing to read. */
  team_slug: string | null;
  initiative: string | null;
  flow: string | null;
  step: string | null;
  step_version: string | null;
  block: string | null;
  block_version: string | null;
  ok: boolean | null;
  refusal: string | null;

  /** Read, never filtered on — which is exactly what a jsonb column is good at. */
  detail: {
    ms?: number;
    bytes?: number;
    /** A stable hash, never a person: it correlates one conversation and identifies nobody. */
    caller?: string;
    /** One conversation, so one evaluation round can be told from the next. */
    run?: string;
    /** Hash of the skill text actually served. The gate refuses a changed skill that kept its
     * version, so this is what is left: a host running text the repo does not claim. */
    step_sha?: string;
    args?: string[];
    shapes?: Record<string, string>;
    ids?: Record<string, string>;
    unreadable?: boolean;
    /** The response never finished — the client hung up, or the upstream died mid-stream.
     * Distinct from `unreadable`, which is an answer we could not parse. */
    aborted?: boolean;
    /** How many calls shared this request. Absent unless more than one did. */
    batched?: number;
  };
}


/**
 * The tool calls to report on.
 *
 * Through psql VARIABLES and stdin, not interpolated into the statement. Every one of these
 * three values comes from the command line, and an operator pasting an address with an
 * apostrophe in it would have produced a syntax error at best. It is the same mistake
 * issue-first-pat.sh made and fixed, repeated one directory over — which is what makes it
 * worth naming rather than quietly correcting: the pattern is what recurs, not the file.
 *
 * psql interpolates while lexing its INPUT, so a statement handed to -c never gets that
 * pass. On stdin it does.
 */
function rows(psql: string, since: string, surface: string | null, actor: string | null): CallRow[] {
  const where = ["ts > now() - (:'since')::interval"];
  // A COLUMN, not a substring of one. `surface` used to be the part of `subject` before the
  // colon, picked out with split_part rather than LIKE because `_` is a LIKE wildcard and
  // `--surface my_block` would have counted calls belonging to `myXblock`. The table has the
  // column now, so the filter says what it means and has nothing left to escape.
  if (surface) where.push("split_part(subject, ':', 1) = :'surface'");
  // ONE RUN, one conversation. This used to filter on an email; a caller is a stable hash now,
  // which is the same filter with nothing personal in it. Without it the report mixes the run
  // being measured with whatever else touched the deployment while it ran — including the
  // operator setting the run up, whose mistakes are not the flow's.
  if (actor) where.push("detail->>'caller' = :'actor'");
  const sql =
    // The kind is IN the statement, not assembled into it. team_slug is null on the kinds
    // written by acts that belong to a person rather than a team — a self-issued PAT, a package
    // download — so a reader of that column has to say which kinds it means, and a scope hidden
    // in a joined array is a scope nothing can check.
    "select ts, subject, team_slug, initiative, flow, step, step_version, block, block_version," +
    " ok, refusal, detail from zz.event where kind = 'tool_call'" +
    ` and ${where.join(" and ")} order by id`;

  const vars: Record<string, string> = { since };
  if (surface) vars.surface = surface;
  if (actor) vars.actor = actor;
  return psqlRows<CallRow>(psql, sql, vars);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * p))];
}

interface Refusal {
  count: number;
  class: string;
  teaches: boolean;
  tool: string;
  args: string[];
  shapes: Record<string, string>;
  text: string;
}
interface ToolStat {
  calls: number;
  ok: number;
  refused: number;
  unreadable: number;
  p50_ms: number;
  p95_ms: number;
  /** How large this tool's answers are. The gateway has recorded it on every call since the
   * telemetry was written and nothing read it — so "which tool floods a context window" was
   * a question the record could answer and nobody could ask. It is not idle: one block
   * publishes a couple of hundred tools whose schemas alone cost 91K of a 115K window, and one of its
   * answers measured 1.2 MB. */
  p95_bytes: number;
}
/** One identifier value, and how often a run named it. */
interface NamedId {
  key: string;
  value: string;
  count: number;
  tools: string[];
}

interface ReportShape {
  generated: string;
  since: string;
  actor: string | null;
  calls: number;
  accepted: number;
  refused: number;
  unreadable: number;
  accepted_rate: number;
  aborted: number;
  tools: Record<string, ToolStat>;
  refusals: Refusal[];
  named: NamedId[];
}

/** Whether a parsed file is one of this tool's own reports.
 *
 * The two fields every reader here uses. --ledger needs it because a stray `notes.json` beside
 * the saved runs must be named and skipped rather than crash the listing; --compare needs it
 * because `as ReportShape` on an arbitrary file is an assertion about a shape nobody checked,
 * and showMovement is written tolerantly enough that the comparison then ran against zeros and
 * reported the whole run as new. Both want the same question answered, so it is asked once. */
function isReport(r: unknown): r is ReportShape {
  return typeof r === "object" && r !== null &&
    typeof (r as ReportShape).calls === "number" && Array.isArray((r as ReportShape).refusals);
}

/**
 * Every saved run, as one row per refusal class.
 *
 * The accepted RATE is the number everyone reaches for and it is the one that lies: it is
 * governed by which tools a run happened to call. One measured run was 93.8% accepted with
 * seven of its eight failures on a single tool — call that tool twice instead of nine times
 * and the rate jumps four points while nothing has been fixed.
 *
 * A refusal CLASS does not move like that. It is present or it is not, and when it stops
 * appearing something was closed. That is what a loop has to show to have earned its cost:
 * not a curve that drifts up, but a row that reaches zero and stays there.
 *
 * A row that never reaches zero across runs is not noise either — it is a defect nobody has
 * taken, which is worth seeing precisely because it is easy to stop noticing.
 */
function showLedger(directory: string): void {
  const files = readdirSync(directory).filter((f) => f.endsWith(".json")).map((f) => join(directory, f));
  if (files.length === 0) die(`no saved reports in ${directory} — write some with --json first`);

  // PARSED ONCE, AND WHAT WILL NOT PARSE IS NAMED. `taken()` below tolerated a file that is
  // not a report — "fall through to the file's own timestamp" — and the very next expression
  // parsed every file again with no such tolerance, so the tolerance was decorative: a stray
  // `notes.json` beside the saved runs ended --ledger on a raw SyntaxError, which is exactly
  // what lib/cli.ts exists to stop an operator seeing.
  //
  // Dropped files are COUNTED and listed rather than skipped quietly. This tool's own ledger
  // is a claim about runs over time, and one that silently leaves runs out is the shape
  // flow-compare names: a silently dropped denominator is how a comparison lies.
  const parsed: { name: string; report: ReportShape; taken: string }[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      skipped.push(`${basename(f)} (not JSON)`);
      continue;
    }
    if (!isReport(report)) {
      skipped.push(`${basename(f)} (JSON, but not a report — no calls/refusals)`);
      continue;
    }
    // Ordered by WHEN each report was taken, not by filename. Sorting by name put a report
    // generated at 21:47 before a hand-named baseline from that morning, so the earlier run's
    // refusal classes — the ones that had in fact CLOSED — were labelled NEW. A ledger that
    // can print an improvement as a regression is worse than no ledger, and the only reason
    // it did was that one of the two files had been named by a person.
    parsed.push({ name: basename(f, ".json"), report, taken: report.generated || localStamp(statSync(f).mtime) });
  }
  if (skipped.length) console.log(`  not read: ${skipped.join(", ")}`);
  if (parsed.length === 0) {
    die(`no readable reports in ${directory} — ${files.length} .json file(s) there, none of ` +
        "them written by --json or --save");
  }
  const loaded = parsed
    .sort((a, b) => a.taken.localeCompare(b.taken))
    .map((x) => [x.name, x.report] as const);

  // One run is a baseline, not a trend, and every class in it would otherwise be marked NEW —
  // which reads as "these just appeared" when it only means "nothing preceded this".
  const solo = loaded.length === 1;
  console.log(
    `\n${loaded.length} run${solo ? "" : "s"} in ${directory}` +
      (solo ? "  — a baseline. Improvement is what the NEXT run does to these rows." : "") +
      "\n",
  );
  const width = Math.max(...loaded.map(([n]) => n.length)) + 2;
  console.log("  " + loaded.map(([n]) => n.padEnd(width)).join(""));
  console.log("  " + loaded.map(([, r]) => `${r.calls} calls`.padEnd(width)).join(""));
  console.log("  " + loaded.map(([, r]) => `${r.accepted_rate}% ok`.padEnd(width)).join(""));
  console.log();

  const classes = new Map<string, number[]>();
  loaded.forEach(([, r], i) => {
    for (const entry of r.refusals ?? []) {
      if (!classes.has(entry.class)) classes.set(entry.class, new Array<number>(loaded.length).fill(0));
      classes.get(entry.class)![i] = entry.count;
    }
  });

  if (classes.size === 0) {
    console.log("  no refusals in any run");
    return;
  }

  // Closed last, open first: what is still costing you belongs at the top.
  //
  // The first key was `counts[last] ? 1 : 0` and the sort is ascending, so a class that had
  // reached zero sorted ABOVE one still costing you every run — the exact inversion of the
  // sentence above it, in the one view whose purpose is to put the open rows where somebody
  // will read them. Still-open sorts first now, and within each group the largest total
  // leads.
  const rank = (counts: number[]): [number, number] => [
    counts[counts.length - 1] ? 0 : 1,
    -counts.reduce((a, b) => a + b, 0),
  ];
  const ordered = [...classes].sort((a, b) => {
    const [ra, sa] = rank(a[1]);
    const [rb, sb] = rank(b[1]);
    return ra - rb || sa - sb;
  });
  for (const [cls, counts] of ordered) {
    const cells = counts.map((c) => (c ? String(c) : "·").padEnd(width)).join("");
    const last = counts[counts.length - 1];
    const state = solo ? "" : !last ? "CLOSED" : counts.slice(0, -1).every((c) => !c) ? "NEW" : "";
    console.log(`  ${cells}${state}`);
    console.log(`      ${cls.slice(0, 96)}\n`);
  }
}

/**
 * What changed since a previous report.
 *
 * A single run says where a flow stalled. Whether the flow is getting BETTER is a comparison,
 * and nothing here was keeping one — each report was read once and lost, so "we ran it again
 * and it improved" stayed an impression. The two numbers that answer it are the accepted rate
 * and, more sharply, which refusal CLASSES appeared and which stopped: a class that is gone is
 * a fix, and a class that is new is a regression, whoever caused it.
 */
function showMovement(now: ReportShape, before: Partial<ReportShape>): void {
  const wasRate = before.accepted_rate ?? 0;
  console.log(`\nsince the report you compared against (${before.calls ?? 0} calls, ${wasRate}% accepted)`);
  console.log("-".repeat(69));
  const delta = now.accepted_rate - wasRate;
  console.log(`  accepted rate ${wasRate}% -> ${now.accepted_rate}% (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`);

  const was = new Map((before.refusals ?? []).map((r) => [r.class, r.count]));
  const isNow = new Map(now.refusals.map((r) => [r.class, r.count]));
  const fixed = [...was.keys()].filter((c) => !isNow.has(c)).sort();
  const fresh = [...isNow.keys()].filter((c) => !was.has(c)).sort();
  for (const cls of fresh) console.log(`  NEW      ${String(isNow.get(cls)).padStart(3)}x  ${cls.slice(0, 110)}`);
  for (const cls of fixed) console.log(`  GONE     ${String(was.get(cls)).padStart(3)}x  ${cls.slice(0, 110)}`);
  for (const cls of [...was.keys()].filter((c) => isNow.has(c)).sort()) {
    if (was.get(cls) !== isNow.get(cls)) {
      console.log(`  ${String(was.get(cls)).padStart(3)} -> ${String(isNow.get(cls)).padEnd(3)}      ${cls.slice(0, 100)}`);
    }
  }
  if (fresh.length === 0 && fixed.length === 0) console.log("  the same refusal classes, in the same shape");
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["json"]);
  // `||`, never `??` with a real default: parseArgs gives "" for a flag written with no
  // value, and "" is not nullish — `--since` alone became an empty psql interval.
  const since = args.flags.get("since") || "24h";
  // Through optional(), like the five below. These two were the exception, and they are the
  // two that decide WHICH CALLS THE REPORT IS ABOUT: `--actor` with nothing after it reported
  // on everybody while the operator read it as one evaluation run's calls, which is the one
  // thing that flag exists to separate.
  const surface = optional(args, "surface", "a surface to narrow to, e.g. `core` or `casebox`");
  const actor = optional(args, "actor", "the address whose calls to report on");
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  // VALIDATED, because this is the one flag here that decides an exit code. `Number("9o")` is
  // NaN and `rate < NaN` is false, so a typo did not fail loudly — it silently removed the
  // gate and every subsequent run passed. A threshold nobody can trip is worse than none,
  // because somebody is relying on it. optional() answers the empty case; this answers the
  // unusable one.
  const failUnderRaw = optional(args, "fail-under", "a percentage between 0 and 100");
  let failUnder: number | null = null;
  if (failUnderRaw !== null) {
    failUnder = Number(failUnderRaw);
    if (!Number.isFinite(failUnder) || failUnder < 0 || failUnder > 100) {
      die(`--fail-under takes a percentage between 0 and 100, got ${JSON.stringify(failUnderRaw)}`);
    }
  }

  // ALL of them here, before the query. --save and --compare are used far below, past the
  // early return for a window with no calls — so a mistyped --save was still accepted in
  // silence on exactly the quiet window where an operator is most likely to be retrying.
  //
  // The rule these share lives in optional(): a flag given with nothing after it is a mistyped
  // flag, not an absent one. It was a local helper here, which is why --surface and --actor
  // three lines above it never got it.
  const ledger = optional(args, "ledger", "the directory holding saved reports");
  const save = optional(args, "save", "a directory to write this run into");
  const compare = optional(args, "compare", "a report file written by --json or --save");

  // The ledger reads saved reports, not the database — it is about runs over time, and a
  // window query cannot separate one run from the next.
  if (ledger) {
    showLedger(ledger);
    return 0;
  }

  const events = rows(psql, since, surface, actor);
  if (events.length === 0) {
    const where = (surface ? ` on ${surface}` : "") + (actor ? ` by ${actor}` : "");
    console.log(`no tool calls in the last ${since}${where}`);
    // A GATE THAT CANNOT FAIL IS NOT A GATE. This returned 0 — "all good" — for exactly the
    // runs most worth catching: an --actor that matches nobody, a window that misses the run,
    // an evaluation that died before it called anything. The accepted rate of no calls is not
    // 100%; there is no rate, and a caller who asked for a floor asked to be told when the
    // floor cannot be established.
    if (failUnder !== null) {
      die(
        `--fail-under ${failUnder} was asked for and there are no tool calls${where} to ` +
          "measure. Nothing passed, because nothing ran.",
      );
    }
    return 0;
  }

  // A call whose answer could not be read is NOT counted as refused. It is a gap in the
  // record, and folding it into either column would make the number a guess.
  const perTool = new Map<string, { calls: number; ok: number; refused: number; unreadable: number; ms: number[]; bytes: number[] }>();
  const refusals = new Map<string, number>();
  // What each call NAMED. Keyed by identifier-and-value so the same skill read twelve times
  // is one row of twelve, which is the shape the question needs: not how many calls a run
  // made, but which things it kept reaching for.
  const named = new Map<string, { key: string; value: string; count: number; tools: Set<string> }>();
  let aborted = 0;
  let batched = 0;
  const example = new Map<string, { tool: string; args: string[]; shapes: Record<string, string>; text: string }>();

  for (const e of events) {
    // The tool, named as the table names it. `<surface>:<tool>` is kept as the display key so
    // the report still reads `casebox:get_cases` rather than losing which door a tool was behind.
    const subject = e.subject;
    const d = e.detail ?? {};
    if (!perTool.has(subject)) perTool.set(subject, { calls: 0, ok: 0, refused: 0, unreadable: 0, ms: [], bytes: [] });
    const t = perTool.get(subject)!;
    t.calls++;
    // NOT FROM A BATCH. The gateway measures one request, so every call in a batch carries
    // the batch's duration and the response's whole size. Averaging those in counts one
    // measurement sixty-two times and calls it sixty-two calls' latency — the batched flag
    // exists precisely so a reader can tell, and nothing was reading it.
    if (d.batched) batched++;
    else {
      if (typeof d.ms === "number" && Number.isInteger(d.ms)) t.ms.push(d.ms);
      if (typeof d.bytes === "number" && d.bytes > 0) t.bytes.push(d.bytes);
    }
    if (d.aborted) aborted++;
    for (const [k, v] of Object.entries(d.ids ?? {})) {
      const id = `${k}=${v}`;
      const seen = named.get(id) ?? { key: k, value: v, count: 0, tools: new Set<string>() };
      seen.count++;
      seen.tools.add(subject);
      named.set(id, seen);
    }
    if (d.unreadable) t.unreadable++;
    else if (e.ok) t.ok++;
    else {
      t.refused++;
      const reason = String(e.refusal ?? "").trim();
      if (reason) {
        const cls = refusalClass(reason).slice(0, 160);
        refusals.set(cls, (refusals.get(cls) ?? 0) + 1);
        if (!example.has(cls)) {
          example.set(cls, { tool: subject, args: d.args ?? [], shapes: d.shapes ?? {}, text: reason });
        }
      }
    }
  }

  const judged = [...perTool.values()].reduce((a, v) => a + v.ok + v.refused, 0);
  const accepted = [...perTool.values()].reduce((a, v) => a + v.ok, 0);
  const rate = judged ? (accepted / judged) * 100 : 0;

  const report: ReportShape = {
    generated: localStamp(),
    since,
    actor,
    calls: events.length,
    accepted,
    refused: judged - accepted,
    unreadable: [...perTool.values()].reduce((a, v) => a + v.unreadable, 0),
    accepted_rate: Math.round(rate * 10) / 10,
    aborted,
    tools: Object.fromEntries(
      [...perTool]
        .sort((a, b) => b[1].refused - a[1].refused || b[1].calls - a[1].calls)
        .map(([name, v]) => [
          name,
          {
            calls: v.calls,
            ok: v.ok,
            refused: v.refused,
            unreadable: v.unreadable,
            p50_ms: percentile(v.ms, 0.5),
            p95_ms: percentile(v.ms, 0.95),
            p95_bytes: percentile(v.bytes, 0.95),
          },
        ]),
    ),
    refusals: [...refusals]
      .sort((a, b) => b[1] - a[1])
      .map(([cls, n]) => ({ count: n, class: cls, teaches: teachesTheRule(example.get(cls)!.text), ...example.get(cls)! })),
    named: [...named.values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .map((n) => ({ key: n.key, value: n.value, count: n.count, tools: [...n.tools].sort() })),
  };

  if (args.flags.has("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `\n${events.length} tool calls in the last ${since} — ${accepted} accepted, ` +
        `${judged - accepted} refused (${report.accepted_rate}% accepted)` +
        (report.unreadable ? `, ${report.unreadable} unreadable` : "") +
        // A call that never came back is the failure most worth seeing and the one least
        // visible: it is not refused, not accepted, and leaves no answer to classify. The
        // gateway has recorded it since the "close" listener was wired; nothing showed it.
        (report.aborted ? `, ${report.aborted} never came back` : ""),
    );
    // Said out loud, because a silently narrowed denominator is how a timing number lies.
    if (batched) {
      console.log(`  ${batched} of them shared a request with another call, so their timing ` +
                  "and size are the request's — left out of the columns below");
    }
    console.log(
      `\n${"tool".padEnd(34)}${"calls".padStart(6)}${"ok".padStart(6)}` +
        `${"refused".padStart(9)}${"p50".padStart(7)}${"p95".padStart(7)}${"p95 bytes".padStart(11)}`,
    );
    console.log("-".repeat(80));
    for (const [name, v] of Object.entries(report.tools)) {
      console.log(
        name.padEnd(34) +
          String(v.calls).padStart(6) +
          String(v.ok).padStart(6) +
          String(v.refused).padStart(9) +
          String(v.p50_ms).padStart(7) +
          String(v.p95_ms).padStart(7) +
          String(v.p95_bytes).padStart(11),
      );
    }
    if (report.refusals.length) {
      console.log(`\nwhy calls were refused (${report.refusals.length} distinct reasons)`);
      console.log("-".repeat(69));
      const mute = report.refusals.filter((r) => !r.teaches).reduce((a, r) => a + r.count, 0);
      if (mute) {
        console.log(`  ${mute} of them taught the caller nothing — a bare status, with no rule to act on (contract R6)`);
      }
      for (const r of report.refusals) {
        const mark = r.teaches ? "" : "  ← teaches nothing (R6)";
        const shape = r.shapes ?? {};
        const shown =
          Object.entries(shape)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || r.args.join(", ");
        console.log(`\n  ${String(r.count).padStart(3)}x  ${r.tool}  ${shown}${mark}`);
        console.log(`       ${r.text.slice(0, 220)}`);
      }
    }

    // WHAT THE RUN KEPT REACHING FOR. The gateway records the identifiers a call names —
    // which skill, which initiative, which block — precisely so this can be asked, and until
    // now nothing asked it: the capture was wired and the reading was not, which is a
    // question that stays unanswerable while looking answered.
    //
    // Skills first, because that is the question it was added for: a run that stalls and a
    // run that finishes load different ones, and the difference is a fact about the method
    // rather than about the model.
    if (report.named.length) {
      const skills = report.named.filter((n) => n.key === "name" && n.tools.some((t) => t.includes("skill_view")));
      // Capped for the terminal, and the cap is stated. A listing that quietly stops at
      // twelve reads as "that is all of them", which is the shape this file objects to three
      // paragraphs up about a narrowed denominator. --json carries every row.
      const allRest = report.named.filter((n) => !skills.includes(n));
      const rest = allRest.slice(0, 12);
      if (skills.length) {
        console.log(`\nskills this run loaded (${skills.length} distinct)`);
        console.log("-".repeat(69));
        for (const n of skills) console.log(`  ${String(n.count).padStart(3)}x  ${n.value}`);
      }
      if (rest.length) {
        console.log("\nwhat else it named");
        console.log("-".repeat(69));
        for (const n of rest) {
          console.log(`  ${String(n.count).padStart(3)}x  ${n.key}=${n.value.slice(0, 50)}`);
        }
        if (allRest.length > rest.length) {
          console.log(`  … and ${allRest.length - rest.length} more, in --json`);
        }
      }
    }
    console.log();
  }

  // A ledger is only as good as the runs saved into it, and "remember to redirect --json into
  // a file with a name you will still understand next week" is the step that quietly stops
  // happening. One flag, one file, named so the series orders itself.
  if (save) {
    mkdirSync(save, { recursive: true });
    const who = (actor ?? "all").split("@")[0];
    const path = join(save, `${report.generated.replace(/:/g, "")}-${who}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`saved ${path}`);
  }

  if (compare) {
    // Named by an operator, so it is mistyped like any other path. Unreadable or not a report
    // ended the run in a parser stack trace, after the report above had already been printed —
    // which reads as the report itself having gone wrong.
    let before: unknown;
    try {
      before = JSON.parse(readFileSync(compare, "utf8"));
    } catch (e) {
      return die(`--compare ${compare}: ${(e as Error).message}. It takes a report written by ` +
                 "--json or --save, not a database or a directory (--ledger reads a directory).");
    }
    // VALID JSON IS NOT A REPORT. The cast said it was, and showMovement reads its fields
    // tolerantly — `before.accepted_rate ?? 0`, `before.refusals ?? []` — so any other JSON
    // file compared cleanly against zeros and reported every refusal class in this run as NEW.
    // A regression is what that looks like.
    if (!isReport(before)) {
      return die(`--compare ${compare} is JSON but not a report — it carries no calls/refusals. ` +
                 "It takes a file written by --json or --save.");
    }
    showMovement(report, before);
  }

  if (failUnder !== null && rate < failUnder) {
    die(`accepted rate ${rate.toFixed(1)}% is below --fail-under ${failUnder}`);
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
