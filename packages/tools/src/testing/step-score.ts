/**
 * step-score — what "better" MEANS for a step, as numbers
 *
 *   zz-tool step-score [--since '7 days'] [--json] [--psql '<command>']
 *
 * WHY THIS EXISTS. Every other report here says where a run went; none says whether that was
 * GOOD. "ops-select refused 8 of 44 calls" is a fact nobody can act on until somebody decides
 * whether 18% is bad — and for ten rounds that decision was made by eye, one round at a time,
 * which is how variance gets written up as improvement. Idle turns went 32% then 0% then 31%
 * across three rounds of one configuration, and the 0% was reported as a rule working.
 *
 * A plugin already had a definition — the conformance contract, scored by `conformance`.
 * Steps had none. This is the missing half.
 *
 * WHAT IS SCORED, AND WHAT DELIBERATELY IS NOT.
 *
 *   OURS, per step     the refusals a better skill would have avoided — a call made with
 *                      arguments the caller could have read first. The only class the flow can
 *                      fix, so the only one a step is scored on.
 *   THEIRS             bare statuses, web pages where a result belongs, tools that are not
 *                      there. Never charged to the step that met them: a step is not worse
 *                      for calling a tool having a bad day.
 *   NEITHER            platform guardrails. A refusal that says which rule was broken is the
 *                      platform WORKING, and scoring it as a defect is how somebody ends up
 *                      weakening a guard that does its job.
 *
 * THE BASELINE IS THE MEDIAN OF WHAT THIS STEP HAS DONE BEFORE. Not a number anybody typed,
 * and not the previous round — that makes every reading a comparison with one day's luck. And
 * only WITHIN A MAJOR: a rate under 2.3 against one under 2.7 is a fair comparison, same intent
 * and two attempts at executing it, while 1.5 against 2.0 is not — the second skill was asked
 * for something the first never was, and reading the gap as a regression blames a change for
 * work it was never doing.
 */
import { refusalOwner, resolveStep } from "@zz/contracts";

import { parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";

/** WHO A REFUSAL BELONGS TO — the contract's own classifier, not a second copy.
 *
 * These four regexes lived here, and nothing that WROTE a refusal could reach them: the
 * gateway recorded every not-ok call as one undifferentiated "refusal" while this file, read
 * by nobody at release time, knew the difference. The classifier is in @zz/contracts beside
 * refusalClass now, and the gateway stamps its verdict onto the event as it happens. */
export const owner = refusalOwner;

interface Row {
  step: string | null;
  step_version: string | null;
  ok: boolean | null;
  refusal: string | null;
  run: string | null;
  /** THE UNIT OF EVIDENCE. Not the round and not the scenario — an initiative is one piece of
   * work, and in production there are no scenarios, only initiatives. "Across 500 initiatives
   * that reached ops-select, is ops-select effective" is the question this table exists to
   * answer, and the initiative is what makes it countable. */
  initiative: string | null;
}

export interface StepScore {
  step: string;
  version: string;
  major: string;
  calls: number;
  /** Refusals the flow could have avoided. The metric a change to this step is judged on. */
  ours: number;
  theirs: number;
  guardrail: number;
  /** ours / calls, because a busy step and a quiet one are not comparable by count. */
  rate: number;
  runs: number;
  /** How many distinct pieces of work this version has been through. THE SAMPLE SIZE, and the
   * only thing that turns a number into a claim: one initiative is an anecdote and five
   * hundred is a property of the step. Printed on every row rather than warned about in prose,
   * so nobody has to remember which numbers were thin. */
  initiatives: number;
  /** The median rate of this step's OTHER versions in the same major, or null when there is
   *  nothing to compare against — the honest answer for a step seen once. */
  baseline: number | null;
  /** Never a judgement without a baseline to make it against. */
  verdict: "better" | "worse" | "same" | "unknown";

  /** ── THE OTHER HALF OF EFFECTIVE ────────────────────────────────────────────
   *
   * A refusal rate says whether the step CALLS things correctly. It does not say whether the
   * work came out right, and those are different questions: a step can make no bad calls and
   * still produce a spec the stakeholder rejects, or fumble a dozen calls on the way to
   * something accepted.
   *
   * So the initiatives this version touched are counted by how they ENDED. `accepted` means a
   * person signed for it; `delivered` means it closed with nobody's signature and owes a line
   * on why; `abandoned` means the work stopped. `open` is neither a success nor a failure —
   * work in flight, kept apart so it cannot be quietly counted as either. */
  accepted: number;
  delivered: number;
  abandoned: number;
  open: number;
  /** The sentences themselves, most frequent first. A count says which step to read; the
   *  sentence is the only thing a skill can actually be edited from.
   *
   *  `seenIn` is how many distinct initiatives produced it, and it is what separates a defect
   *  in the step from a bad afternoon. A sentence that appears twenty times inside one piece of
   *  work is one agent stuck in a loop; the same sentence across five is the skill. */
  says: { text: string; n: number; seenIn: number }[];
}


const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Ordered by HOW MANY PIECES OF WORK produced it, then by count. A sentence seen once in five
 * initiatives is worth more than one seen forty times in a single stuck run, and sorting by raw
 * count puts the stuck run first every time. */
const top = (m: Map<string, { n: number; where: Set<string> }>): { text: string; n: number; seenIn: number }[] =>
  [...m]
    .map(([text, v]) => ({ text, n: v.n, seenIn: v.where.size }))
    .sort((a, b) => b.seenIn - a.seenIn || b.n - a.n)
    .slice(0, 5);

export function score(rows: Row[], endings: Ending[] = []): { steps: StepScore[] } {
  // One outcome per initiative. A store holds several documents per initiative and only the
  // closing one carries the outcome, so the rest are null and must not overwrite it.
  const endedAs = new Map<string, string>();
  for (const e of endings) if (e.outcome) endedAs.set(e.initiative, e.outcome);
  const tally = (initiatives: Set<string>) => {
    const t = { accepted: 0, delivered: 0, abandoned: 0, open: 0 };
    for (const i of initiatives) {
      const o = endedAs.get(i);
      if (o === "accepted") t.accepted += 1;
      else if (o === "delivered") t.delivered += 1;
      else if (o === "abandoned") t.abandoned += 1;
      else t.open += 1;
    }
    return t;
  };
  const perStep = new Map<string, {
    calls: number; ours: number; theirs: number; guardrail: number;
    runs: Set<string>; initiatives: Set<string>;
    says: Map<string, { n: number; where: Set<string> }>;
  }>();

  for (const r of rows) {
    if (r.step) {
      // Resolved through SKILL_ALIAS (FR-37a) so a step renamed mid-window scores as one
      // series — a step is a known skill name, matched against the same map tool-report uses.
      const k = `${resolveStep(r.step)} ${r.step_version ?? ""}`;
      const s = perStep.get(k) ?? {
        calls: 0, ours: 0, theirs: 0, guardrail: 0,
        runs: new Set<string>(), initiatives: new Set<string>(),
        says: new Map<string, { n: number; where: Set<string> }>(),
      };
      s.calls += 1;
      if (r.run) s.runs.add(r.run);
      if (r.initiative) s.initiatives.add(r.initiative);
      if (r.refusal) {
        const o = owner(r.refusal);
        if (o === "ours") {
          s.ours += 1;
          const key = r.refusal.replace(/\s+/g, " ").trim().slice(0, 180);
          const seen = s.says.get(key) ?? { n: 0, where: new Set<string>() };
          seen.n += 1;
          if (r.initiative) seen.where.add(r.initiative);
          s.says.set(key, seen);
        } else if (o === "theirs") {
          s.theirs += 1;
        } else if (o === "guardrail") {
          s.guardrail += 1;
        }
      }
      perStep.set(k, s);
    }
  }

  const raw = [...perStep].map(([k, s]) => {
    const [step, version] = k.split(" ");
    return {
      step,
      version: version || "(none)",
      major: (version || "").split(".")[0],
      calls: s.calls,
      ours: s.ours,
      theirs: s.theirs,
      guardrail: s.guardrail,
      rate: s.calls ? s.ours / s.calls : 0,
      runs: s.runs.size,
      initiatives: s.initiatives.size,
      ...tally(s.initiatives),
      says: top(s.says),
    };
  });

  const steps: StepScore[] = raw
    .map((r) => {
      // The step's OTHER versions in the same major. Excluding itself, because a version
      // compared against a set containing itself is dragged toward its own number, and a step
      // seen under one version would always read as exactly average.
      const peers = raw.filter((p) => p.step === r.step && p.major === r.major && p.version !== r.version);
      const baseline = median(peers.map((p) => p.rate));
      const verdict: StepScore["verdict"] = baseline === null
        ? "unknown"
        : Math.abs(r.rate - baseline) < 0.02
          ? "same"
          : r.rate < baseline ? "better" : "worse";
      return { ...r, baseline, verdict };
    })
    .sort((a, b) => b.ours - a.ours || b.calls - a.calls);

  return { steps };
}

/** How each initiative ended, from the platform's own record. Read separately from the calls
 * because an outcome belongs to a piece of WORK and a refusal belongs to a CALL, and joining
 * them in SQL would multiply one by the other. */
interface Ending { initiative: string; outcome: string | null }

function readEndings(psql: string, since: string): Ending[] {
  // No DISTINCT with an ORDER BY it does not select: the outcome is deduplicated in code
  // instead, where an initiative's several documents collapse to the one that carries it.
  return psqlRows<Ending>(psql,
    "select d.initiative, d.outcome from zz.doc d" +
    " where exists (select 1 from zz.event e where e.kind = 'tool_call'" +
    "   and e.team_slug = d.team_slug and e.initiative = d.initiative" +
    "   and e.ts > now() - (:'since')::interval)", { since });
}

export function readRows(psql: string, since: string): Row[] {
  return psqlRows<Row>(psql,
    "select step, step_version, ok, refusal, initiative," +
    " detail->>'run' as run" +
    " from zz.event where kind = 'tool_call'" +
    " and ts > now() - (:'since')::interval order by id", { since });
}


function main(argv: string[]): number {
  const { flags } = parseArgs(argv, ["json"]);
  const psql = flags.get("psql") || DEFAULT_PSQL;
  const since = flags.get("since") || "7 days";
  const rows = readRows(psql, since);
  const out = score(rows, readEndings(psql, since));

  if (flags.has("json")) {
    console.log(JSON.stringify({ since, calls: rows.length, ...out }, null, 2));
    return 0;
  }

  const pct = (x: number | null): string => (x === null ? "  -  " : `${(x * 100).toFixed(1)}%`);
  const pad = (s: unknown, n: number): string => String(s).padEnd(n);

  console.log("");
  console.log("== WHAT BETTER MEANS HERE");
  console.log("");
  console.log("  For a STEP: the refusals a better skill would have avoided - a call made with");
  console.log("  arguments the caller could have read first. The only class the flow can fix, so");
  console.log("  the only one a step is scored on.");
  console.log("  THEIRS: bare statuses, web pages where a result belongs, tools that are not");
  console.log("  there. Never charged to the step that met them.");
  console.log("  Platform guardrails are scored against nobody: a refusal that says which rule was");
  console.log("  broken is the platform working.");
  console.log("");

  if (!rows.length) {
    console.log(`  No tool calls in the last ${since}. Nothing to score - run the flow first.`);
    console.log("");
    return 0;
  }

  console.log(`== STEPS - ${rows.length} call(s) over ${since}`);
  console.log("");
  console.log(`  ${pad("step", 16)}${pad("ver", 6)}${pad("calls", 7)}${pad("ours", 6)}${pad("rate", 8)}${pad("base", 8)}${pad("work", 6)}${pad("ended", 14)}verdict`);
  for (const s of out.steps) {
    const ended = `${s.accepted}a ${s.delivered}d ${s.open}open`;
    console.log(`  ${pad(s.step, 16)}${pad(s.version, 6)}${pad(s.calls, 7)}${pad(s.ours, 6)}${pad(pct(s.rate), 8)}${pad(pct(s.baseline), 8)}${pad(s.initiatives, 6)}${pad(ended, 14)}${s.verdict}`);
  }
  console.log("");
  console.log("  TWO HALVES, and a step needs both. `rate` says whether it CALLS things correctly.");
  console.log("  `ended` says whether the work came out right — a step can make no bad calls and");
  console.log("  still produce a spec the stakeholder rejects, or fumble a dozen on the way to");
  console.log("  something accepted. `ended` reads Na Nd Nopen: accepted, delivered, in flight.");
  console.log("  something accepted. `open` is work in flight, neither a success nor a failure,");
  console.log("  kept apart so it cannot be quietly counted as either.");
  console.log("");
  console.log("  `work` is how many distinct initiatives this version has been through - the sample");
  console.log("  size. One is an anecdote; five hundred is a property of the step. The number is on");
  console.log("  every row so nobody has to remember which readings were thin.");

  const worst = out.steps.find((s) => s.ours > 0);
  if (worst) {
    console.log("");
    console.log(`  The step to read first is ${worst.step} @ ${worst.version}, and this is what it heard:`);
    for (const s of worst.says) {
      console.log(`    ${String(s.n).padStart(3)}x across ${s.seenIn} initiative(s)  ${s.text}`);
    }
    console.log("");
    console.log("  READ THE `across` COLUMN BEFORE THE COUNT. Forty of one sentence inside a single");
    console.log("  initiative is one agent stuck in a loop; the same sentence across five is the");
    console.log("  skill, and only the second is worth changing a skill for.");
  } else {
    console.log("");
    console.log("  No refusal in this window was one the flow could have avoided.");
  }


  const unknown = out.steps.filter((s) => s.verdict === "unknown").length;
  if (unknown) {
    console.log("");
    console.log(`  ${unknown} step(s) have been seen under one version only, so nothing here can say`);
    console.log("  whether a change helped. Change a skill, run again, and this becomes the comparison.");
  }
  console.log("");
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
