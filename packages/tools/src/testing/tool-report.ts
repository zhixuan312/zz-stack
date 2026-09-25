/**
 * tool-report — what the platform's tools actually did, from the platform's own record.
 *
 * Reads `zz.event` where kind = 'tool_call' and answers which tools are being refused, why, and
 * how long they take. The reasons are the platform's own refusal messages, written to say which
 * rule was broken; grouped, they say where a flow stalls.
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
 * Run it on the deployment host: it reads the platform database through the compose project, the
 * same way backup.sh and issue-first-pat.sh do. --psql overrides that for anywhere else.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { refusalClass, resolveStep, resolveToolKey } from "@zz/contracts";

import { die, optional, parseArgs } from "../lib/cli.js";
import { showLedger, showMovement } from "./tool-report-history.js";
import { teachesTheRule } from "../lib/refusal.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";
import { localStamp } from "../lib/shell.js";

// Re-exported so the alias-applied and skill-renames checks find the resolvers `perTool` groups
// through in one place. The maps and the resolution live in @zz/contracts/alias.ts.
export { resolveToolKey, resolveStep };

// A refusal must teach the rule: a refusal that names a status and stops gives the agent nothing
// to change, and it retries the same call until it gives up. The judgement lives in
// lib/refusal.ts.

/** A `tool_call` row of zz.event. Flat columns, because the table has them. */
interface CallRow {
  ts: string;
  subject: string;                       // `<surface>:<tool>`

  /* The dimensions and the outcome: which of a step's revisions ran, and its own account of
   * itself; whether the call worked and, when it did not, the platform's own sentence
   * saying which rule was broken. These are columns because somebody groups by them.
   *
   * `initiative` and `team_slug` are the join keys to zz.doc and zz.decision — without them a
   * refusal cannot be connected to the document it was made for or the claim it was testing.
   *
   * `flow` is the flow the call's initiative was opened with, or null when the call named no
   * initiative. `plugin` below is resolved from the door the call arrived on. */
  team_slug: string | null;
  initiative: string | null;
  flow: string | null;
  step: string | null;
  step_version: string | null;
  /** Which plugin owns the skill `step` names, and its released version — resolved at write
   * time through zz.plugin_version_skill, never from `flow` (a team's last install, not a
   * skill's owner) and never guessed at: an unresolvable step leaves both null. */
  plugin: string | null;
  plugin_version: string | null;
  /** `<surface>:<tool>`, alias-resolved as of write time — a snapshot, not a live answer. A row
   * older than this column carries none and falls back to `subject`. Either way it still passes
   * through `resolveToolKey` below rather than being trusted outright: a tool renamed again after
   * the snapshot would stay stuck under the superseded name. A no-op when it is already current. */
  tool_key: string | null;
  ok: boolean | null;
  refusal: string | null;
  /** Who the refusal belongs to, stamped at ingest by @zz/contracts' refusalOwner().
   *
   * Four owners: `guardrail` is the platform saying no by name and working as intended, `ours` is
   * a malformed call, `theirs` is the tool failing, `other` is a sentence that says neither. A
   * report that totals all four answers "is the surface breaking" with whatever share happens to
   * be one client's argument bug. Null on a call that worked, and on an old row the backfill
   * did not reach. */
  refusal_owner: string | null;
  /** What the call cost. Null means not measured, never a guessed zero — a request that failed
   * before tool-telemetry.ts started timing it leaves these unset. `batched` is never null: the
   * gateway always knows whether a request carried more than one call, and a row's duration and
   * response size belong to it alone only when this is false. */
  duration_ms: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  batched: boolean;

  /** Read, never filtered on — which is exactly what a jsonb column is good at. */
  detail: {
    /** A stable hash, never a person: it correlates one conversation and identifies nobody. */
    caller?: string;
    /** Which of our own tools made the call — the chat plugin, a command, a harness. Names a
     * piece of software, never a person, and is what "which of the things we ship get used" is
     * counted from. */
    client?: string;
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
  };
}


/**
 * The tool calls to report on.
 *
 * Through psql variables and stdin, not interpolated into the statement: all three values come
 * from the command line, and an operator pasting an address with an apostrophe in it would
 * produce a syntax error at best.
 *
 * psql interpolates while lexing its input, so a statement handed to -c never gets that pass. On
 * stdin it does.
 */
function rows(psql: string, since: string, surface: string | null, actor: string | null): CallRow[] {
  const where = ["ts > now() - (:'since')::interval"];
  // A column, not a substring of one. `_` is a LIKE wildcard, so `--surface my_door` matched
  // against a split-out substring would count calls belonging to `myXdoor`.
  if (surface) where.push("split_part(subject, ':', 1) = :'surface'");
  // One run, one conversation, keyed on the caller hash. Without it the report mixes the run being
  // measured with whatever else touched the deployment while it ran, including the operator
  // setting the run up.
  if (actor) where.push("detail->>'caller' = :'actor'");
  const sql =
    // The kind is in the statement, not assembled into it. team_slug is null on the kinds written
    // by acts that belong to a person rather than a team — a self-issued PAT, a package download —
    // so a reader of that column has to say which kinds it means.
    "select ts, subject, team_slug, initiative, flow, step, step_version, plugin, plugin_version," +
    " tool_key," +
    " ok, refusal, refusal_owner, duration_ms, request_bytes, response_bytes, batched, detail" +
    " from zz.event where kind = 'tool_call'" +
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

export interface Refusal {
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
  /** How large this tool's answers are, so "which tool floods a context window" is answerable.
   * One server can publish enough tools that their schemas alone fill most of a context window,
   * and one of its answers can run to megabytes. */
  p95_bytes: number;
}
/** One identifier value, and how often a run named it. */
interface NamedId {
  key: string;
  value: string;
  count: number;
  tools: string[];
}

export interface ReportShape {
  generated: string;
  since: string;
  actor: string | null;
  calls: number;
  accepted: number;
  refused: number;
  unreadable: number;
  accepted_rate: number;
  aborted: number;
  /** A `subject` with no colon to split — counted under its own raw value in `tools` rather
   * than dropped, and named here so an operator can see the row exists and go read it. */
  unparseable: number;
  tools: Record<string, ToolStat>;
  /** One row per client — which of the things we ship actually get run, and how often they are
   * refused. Named software, never a person. */
  clients: ClientStat[];
  refusals: Refusal[];
  /** How many refused calls belonged to each owner: guardrail, ours, theirs, other. */
  refusalsByOwner: Record<string, number>;
  named: NamedId[];
}

interface ClientStat { client: string; calls: number; refused: number; tools: number }

/** Whether a parsed file is one of this tool's own reports.
 *
 * --ledger needs it so a stray `notes.json` beside the saved runs is named and skipped rather than
 * crashing the listing; --compare needs it because showMovement reads fields tolerantly, so any
 * other JSON file compares cleanly against zeros and reports the whole run as new. */
export function isReport(r: unknown): r is ReportShape {
  return typeof r === "object" && r !== null &&
    typeof (r as ReportShape).calls === "number" && Array.isArray((r as ReportShape).refusals);
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["json"]);
  // `||`, never `??` with a real default: parseArgs gives "" for a flag written with no
  // value, and "" is not nullish — `--since` alone became an empty psql interval.
  const since = args.flags.get("since") || "24h";
  // Through optional(), like the flags below: `--actor` with nothing after it reports on everybody
  // while the operator reads it as one evaluation run's calls.
  const surface = optional(args, "surface", "a surface to narrow to, e.g. `core` or `eval`");
  const actor = optional(args, "actor", "the address whose calls to report on");
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  // Validated, because this is the one flag here that decides an exit code. `Number("9o")` is NaN
  // and `rate < NaN` is false, so a typo silently removes the gate. optional() answers the empty
  // case; this answers the unusable one.
  const failUnderRaw = optional(args, "fail-under", "a percentage between 0 and 100");
  let failUnder: number | null = null;
  if (failUnderRaw !== null) {
    failUnder = Number(failUnderRaw);
    if (!Number.isFinite(failUnder) || failUnder < 0 || failUnder > 100) {
      die(`--fail-under takes a percentage between 0 and 100, got ${JSON.stringify(failUnderRaw)}`);
    }
  }

  // All of them here, before the query. --save and --compare are used far below, past the early
  // return for a window with no calls, so a mistyped --save would be accepted in silence on
  // exactly the quiet window where an operator is most likely to be retrying.
  //
  // The rule these share lives in optional(): a flag given with nothing after it is a mistyped
  // flag, not an absent one.
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
    // A gate that cannot fail is not a gate. The accepted rate of no calls is not 100%; there is
    // no rate, and a caller who asked for a floor asked to be told when the floor cannot be
    // established.
    if (failUnder !== null) {
      die(
        `--fail-under ${failUnder} was asked for and there are no tool calls${where} to ` +
          "measure. Nothing passed, because nothing ran.",
      );
    }
    return 0;
  }

  // A call whose answer could not be read is not counted as refused. It is a gap in the
  // record, and folding it into either column would make the number a guess.
  const perTool = new Map<string, { calls: number; ok: number; refused: number; unreadable: number; ms: number[]; bytes: number[] }>();
  const refusals = new Map<string, number>();
  /** Refused calls by who the refusal belongs to — see CallRow.refusal_owner. */
  const byOwner: Record<string, number> = {};
  // What each call named. Keyed by identifier-and-value, so the same skill read twelve times is
  // one row of twelve: not how many calls a run made, but which things it kept reaching for.
  const named = new Map<string, { key: string; value: string; count: number; tools: Set<string> }>();
  // One row per client — the chat plugin, each command, each harness — so "improve the tools
  // people use" can name which those are.
  const perClient = new Map<string, { calls: number; refused: number; tools: Set<string> }>();
  let aborted = 0;
  let batched = 0;
  let unparseable = 0;
  const example = new Map<string, { tool: string; args: string[]; shapes: Record<string, string>; text: string }>();

  for (const e of events) {
    // `tool_key` preferred when the row has one, but resolved again rather than trusted outright:
    // it is a write-time snapshot, and a second rename after that row was written would leave it
    // stuck under a superseded name. `<surface>:<tool>` stays the display key either way.
    if (!(e.tool_key ?? e.subject).includes(":")) unparseable++;
    const subject = resolveToolKey(e.tool_key ?? e.subject);
    const d = e.detail ?? {};
    if (!perTool.has(subject)) perTool.set(subject, { calls: 0, ok: 0, refused: 0, unreadable: 0, ms: [], bytes: [] });
    const t = perTool.get(subject)!;
    t.calls++;
    // Not from a batch. The gateway measures one request, so every call in a batch carries the
    // batch's duration and the response's whole size; averaging those in counts one measurement
    // once per call in the batch and calls it latency.
    {
      // `unattributed` rather than dropping the row: a client that sends no header is a caller we
      // ship and forgot to tag.
      const c = d.client || "unattributed";
      if (!perClient.has(c)) perClient.set(c, { calls: 0, refused: 0, tools: new Set() });
      const pc = perClient.get(c)!;
      pc.calls++;
      pc.tools.add(subject);
      if (e.ok === false) pc.refused++;
    }
    if (e.batched) batched++;
    else {
      if (typeof e.duration_ms === "number" && Number.isInteger(e.duration_ms)) t.ms.push(e.duration_ms);
      if (typeof e.response_bytes === "number" && e.response_bytes > 0) t.bytes.push(e.response_bytes);
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
      // Counted by owner too. The class says which sentence; the owner says whose problem it is —
      // a rising `guardrail` class is a skill to edit, a rising `ours` is a client to fix, and
      // totalling them hides whichever is smaller behind whichever is louder.
      byOwner[e.refusal_owner ?? "other"] = (byOwner[e.refusal_owner ?? "other"] ?? 0) + 1;
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
    unparseable,
    clients: [...perClient]
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([client, v]) => ({ client, calls: v.calls, refused: v.refused, tools: v.tools.size })),
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
    refusalsByOwner: byOwner,
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
        // A call that never came back is not refused, not accepted, and leaves no answer to
        // classify.
        (report.aborted ? `, ${report.aborted} never came back` : "") +
        // A subject with no colon to split — counted under its own raw value above rather
        // than dropped, and said out loud so an operator goes and reads that row.
        (report.unparseable ? `, ${report.unparseable} unparseable subject(s)` : ""),
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

    // What the run kept reaching for: the gateway records the identifiers a call names — which
    // skill, which initiative.
    //
    // Skills first: a run that stalls and a run that finishes load different ones, and the
    // difference is a fact about the method rather than about the model.
    if (report.clients.length) {
      console.log(`\nwhat made these calls (${report.clients.length} client${report.clients.length > 1 ? "s" : ""})`);
      console.log("-".repeat(69));
      for (const c of report.clients) {
        const refused = c.refused ? `, ${c.refused} refused` : "";
        console.log(`  ${String(c.calls).padStart(4)}  ${c.client.padEnd(18)} ${c.tools} distinct tool${c.tools > 1 ? "s" : ""}${refused}`);
      }
    }
    if (report.named.length) {
      // `skill_read`, the resolved name: `named.tools` holds subjects already folded through
      // resolveToolKey, so an unresolved spelling matches no row and this section stops rendering.
      const skills = report.named.filter((n) => n.key === "name" && n.tools.some((t) => t.includes("skill_read")));
      // Capped for the terminal, and the cap is stated: a listing that quietly stops at twelve
      // reads as "that is all of them". --json carries every row.
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

  // One flag, one file, named so the series orders itself — a ledger is only as good as the runs
  // saved into it.
  if (save) {
    mkdirSync(save, { recursive: true });
    const who = (actor ?? "all").split("@")[0];
    const path = join(save, `${report.generated.replace(/:/g, "")}-${who}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`saved ${path}`);
  }

  if (compare) {
    // Named by an operator, so it is mistyped like any other path. Unreadable or not a report
    // ended the run in a parser stack trace after the report above had already been printed.
    let before: unknown;
    try {
      before = JSON.parse(readFileSync(compare, "utf8"));
    } catch (e) {
      return die(`--compare ${compare}: ${(e as Error).message}. It takes a report written by ` +
                 "--json or --save, not a database or a directory (--ledger reads a directory).");
    }
    // Valid JSON is not a report. showMovement reads its fields tolerantly — `before.accepted_rate
    // ?? 0`, `before.refusals ?? []` — so any other JSON file compares cleanly against zeros and
    // reports every refusal class in this run as new.
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

// Only when run as the CLI. The checks that verify the resolvers import this file — an import must
// not also run the CLI's psql query and exit the process under it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
