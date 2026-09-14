/**
 * THE ABLATION HALF: does installing this plugin help, versus not installing it?
 *
 * `claude plugin eval` runs a suite of cases twice — once with the plugin, once without — and
 * reports the delta. That counterfactual is the one question this platform has never asked. A
 * score says "the documents were good"; a delta says "and they would not have been without
 * this".
 *
 * TWO THINGS FOLLOW FROM WHERE IT RUNS, and both shape this module.
 *
 * It is a CLI on the person's own machine, spending their own credential — measured at roughly
 * $0.40 per case, so four cases is about $1.60 a round. zz-core runs in a container on the host
 * and cannot see their plugin cache at all. So nothing here reads a results directory: the stage
 * skill runs the command where it can be run and RECORDS the JSON, and this reads what was
 * recorded. A tool that tried to read the filesystem would return nothing forever, for a reason
 * no error message would give.
 *
 * And because it is recorded rather than read, it has a timestamp — which is the field that
 * matters most. A delta from three weeks ago presented as the current answer is worse than no
 * delta, and `last_run` is what lets the profile say so out loud.
 *
 * SUFFICIENCY IS ITS OWN LINE. One case is enough for this half to be worth reading, because
 * cases need no history — that is the whole reason they are here. The trace half needs five
 * usable runs and may be insufficient while this one is fine; neither waits for the other.
 */
import type pg from "pg";

interface PluginCase {
  name: string;
  delta: number;
  with_score: number;
  without_score: number;
  runs: number;
  /** Whether this case tells the two arms apart at all, and which way. A case both arms pass is
   *  not a case about the plugin, and one both arms fail is a case that is broken or too hard.
   *  `harmful` is the fourth answer and it is not a synonym for any of the others: the arm WITH
   *  the plugin did measurably worse. Reported as a fact; what to do about it is the person's
   *  call. */
  discriminating: "strong" | "weak" | "dead" | "harmful";
  /** What this case's runs cost, summed over every run of both arms, and what grading them
   *  cost on top. `null` means the payload carries no such field — rows recorded before the
   *  CLI reported one — and it is NOT the same fact as `0`. A run that timed out really did
   *  cost 0.000000, which is exactly what the frozen 2.1.269 run shows for its first six
   *  runs, so an absent figure that arrived as zero would read as "instant and free". */
  cost_usd: number | null;
  judge_cost_usd: number | null;
}

interface PluginCases {
  count: number;
  mean_delta: number | null;
  last_run: string | null;
  cases_digest: string;
  sufficient: boolean;
  cases: PluginCase[];
  /** Runs that errored or timed out, over both arms of every case.
   *
   * A run that never finished scores 0, and a 0 from a dead agent is indistinguishable in the
   * mean from a 0 the plugin earned. Carried beside the mean rather than folded into it, so a
   * delta computed over a suite that half fell over cannot be read as a measurement. */
  errored_runs: number;
  /** The CLI's own `partial` flag: the suite did not finish. */
  partial: boolean;
  /** WHAT THE RUN COST, read from what was already stored so that answering it a second time
   * is free. The suite is roughly $0.40 a case on somebody's own credential, which is the
   * whole reason `047_plugin_eval.sql` keeps the payload whole rather than a mean.
   *
   * `cost_usd` is the payload's own top-level figure. `judge_cost_usd` is summed from the
   * runs, because the top level carries no judge figure and does NOT include it: on the
   * frozen run the per-run `costUsd` sum to 4.266979 and match the top level exactly, while
   * grading added 0.059725 on top of that. Two numbers, not one, because they are two bills.
   *
   * Both are `null` when the payload has no cost field at all. There is deliberately no
   * token count: the payload carries none, and a figure this module invented would be worse
   * than the absence.
   *
   * NOTHING HERE CAPS ANYTHING (FR-8a). Cost is recorded and reported; a ceiling would abort
   * a real run to enforce a guess, and a half-finished suite reports a partial SCORE, which
   * is worse than a large bill because it looks like a result. */
  cost_usd: number | null;
  judge_cost_usd: number | null;
  /** Why there is nothing, when there is nothing. Never a fabricated delta. */
  reason?: string;
}

/** THE COST SURVIVES AN UNREADABLE RUN. Every `EMPTY` but the one for "no row exists" is
 *  returned for a payload that IS there and merely does not parse — and that payload was still
 *  paid for. The frozen 2.1.269 run is exactly this case: it has one arm, no `scoreWithout`
 *  and no `delta`, so every case is skipped and the block is empty, while the run cost
 *  $4.266979 that somebody would otherwise have to spend again to find out.
 *
 *  THAT RUN IS A ROW THIS PLATFORM CAN ACTUALLY HOLD, which it was not until `worthRecording`
 *  below replaced a `!read.count` guard at the recording door. A path built for a payload the
 *  only writer refuses is not a path. */
const EMPTY = (reason: string, facts: RunFacts = NO_FACTS): PluginCases => ({
  count: 0, mean_delta: null, last_run: null, cases_digest: "", sufficient: false, cases: [],
  errored_runs: facts.errored_runs, partial: facts.partial,
  cost_usd: facts.cost_usd, judge_cost_usd: facts.judge_cost_usd,
  reason,
});

/** WHAT THE RUN IS, as against what its cases scored — the four facts that are true of a
 *  payload whether or not a single delta can be read out of it.
 *
 *  It carried the cost alone at first, and that was the bug rather than an omission. The
 *  error count was moved above the delta skip so a case with no delta would still contribute
 *  its dead runs, and the number it produced was then dropped on the next line, because the
 *  `EMPTY` the frozen run returns through hardcoded `errored_runs: 0` and `partial: false`.
 *  Nine runs that the host slept through still reported a clean suite. So the fields travel
 *  together: a fact about the RUN cannot be conditional on a case being readable, and
 *  `partial` — the CLI's own "this suite did not finish" — is exactly the same kind of fact
 *  as the cost, which is why it sits here and not beside the scores. */
interface RunFacts {
  cost_usd: number | null;
  judge_cost_usd: number | null;
  errored_runs: number;
  partial: boolean;
}
const NO_FACTS: RunFacts = { cost_usd: null, judge_cost_usd: null, errored_runs: 0, partial: false };

/** Whether a parsed payload is worth storing at all.
 *
 * A CASE OR A COST — either alone is enough. The recording door used to admit a payload only
 * if a case parsed, which refused the frozen 2.1.269 run outright: no arm to compare, so no
 * delta, so no case, so `ERROR: nothing was recorded` for a suite that had just spent $4.27.
 * That is exactly the money `047_plugin_eval.sql` keeps the payload whole to protect — a
 * result thrown away at the door has to be paid for again to be asked anything.
 *
 * The refusal stays for the payload that carries NEITHER: no case and no cost is not an
 * expensive measurement, it is noise, and the retention rule was not written for it.
 *
 * Exported and pure so the door's rule can be run rather than read. */
export function worthRecording(read: PluginCases): boolean {
  return read.count > 0 || read.cost_usd !== null || read.judge_cost_usd !== null;
}

/** Sum the runs that carry `key`, and report absence as absence.
 *
 * `null` when no run carried the field at all; a number, possibly 0, when one did. The
 * distinction is the whole point: `+null` is `0` in JavaScript, and a total that quietly
 * became 0 would tell a reader an unmeasured suite was free. */
function sumOverRuns(runs: Record<string, unknown>[], key: string): number | null {
  let total: number | null = null;
  for (const r of runs) if (typeof r[key] === "number") total = (total ?? 0) + (r[key] as number);
  return total;
}

/** Where a case sits between "the plugin decided this" and "this decides nothing".
 *
 * The thresholds are round numbers and are meant to be argued with — they classify a FACT
 * (the delta) into a shape a person can act on, which is the one place in this module that is
 * not purely mechanical, and it is reported beside the delta itself so nobody has to trust it. */
function discriminationOf(delta: number, withScore: number): PluginCase["discriminating"] {
  void withScore;
  if (delta >= 0.5) return "strong";
  if (delta > 0.1) return "weak";
  // THE NEGATIVE SIDE IS NOT "dead", which is what this returned for every delta below 0.1
  // including the ones well below zero. A case the plugin arm loses is the single most
  // interesting result a suite can produce -- installing it made the answer worse -- and
  // filing it under the label for "this case decides nothing" hides exactly that. The band is
  // symmetric with the `weak` band above it so the two are read the same way.
  if (delta <= -0.1) return "harmful";
  // Both arms pass, or both fail. Either way the case does not tell them apart.
  return "dead";
}

/** The most recent recorded run for one plugin version. */
export async function pluginCases(pool: pg.Pool, plugin: string, version: string): Promise<PluginCases> {
  const { rows } = await pool.query<{ ran_at: string; cases_digest: string; result: unknown }>(`
    select cr.ran_at::text, cr.cases_digest, cr.result
      from zz.plugin_case_run cr
      join zz.plugin_version pv on pv.id = cr.plugin_version_id
      join zz.plugin p on p.id = pv.plugin_id
     where p.name = $1 and pv.version = $2
     order by cr.ran_at desc
     limit 1`, [plugin, version]);
  const row = rows[0];
  if (!row) {
    return EMPTY(
      `no case run has been recorded for ${plugin} ${version}. Run ` +
      `\`claude plugin eval ${plugin}@zz-stack --json\` and record it — it is a deliberate act ` +
      "because it costs real money on your own credential, so nothing runs it for you");
  }
  return parseCaseRun(row.result, row.ran_at, row.cases_digest);
}

/** The CLI's --json output, turned into facts.
 *
 * SEPARATE AND EXPORTED so that recording a run can validate what it is about to store, rather
 * than discovering at read time that the shape moved. `claude plugin eval` is an early feature
 * whose case schema is not in its own --help; when its output changes, this is the one place
 * that has to learn, and it must say so rather than inventing a number. */
export function parseCaseRun(result: unknown, ranAt: string, casesDigest: string): PluginCases {
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const root = asRecord(result);
  // THE RUN TOTAL IS READ BEFORE ANY CASE IS, so that a payload whose cases cannot be parsed
  // still says what it cost. `typeof === "number"` rather than a fallback: absent is null.
  const rootCost = root && typeof root.costUsd === "number" ? root.costUsd : null;
  const raw = root && Array.isArray(root.cases) ? root.cases : null;
  if (!raw) {
    // `partial` is read here too, and `errored_runs` deliberately is not. Both are run facts,
    // but the per-run errors live inside the `cases` array this branch has just established is
    // missing, so 0 is the honest count rather than a hardcoded one — there are no runs to
    // count. `partial` is at the top level and readable, so reading it costs a field access
    // and saying "the suite finished" about a suite that did not would be a lie.
    return EMPTY(
      "the recorded result has no `cases` array — `claude plugin eval --json` has changed shape, " +
      "and this reports that rather than guessing a delta from it",
      { cost_usd: rootCost, judge_cost_usd: null, errored_runs: 0, partial: root?.partial === true });
  }

  const cases: PluginCase[] = [];
  let errored = 0;
  // Summed across every case, whether or not the case turned out to be readable.
  let summedCost: number | null = null;
  let summedJudge: number | null = null;
  for (const entry of raw) {
    const c = asRecord(entry);
    if (!c) continue;
    const num = (o: Record<string, unknown> | null, k: string): number | null =>
      (o && typeof o[k] === "number" ? o[k] as number : null);

    // WHERE THE NUMBERS ACTUALLY ARE: nested under `aggregates`, not at the case's top level.
    // Nothing at a case's top level is named `delta`, `with_score` or `with`, and this module
    // once read only those flat spellings, so it found no delta anywhere and called a real run
    // unreadable. The flat spellings are kept below the nested ones because they cost a line
    // and this schema is not in the CLI's own --help.
    //
    // THE FULL AGGREGATE SHAPE IS NOT VERIFIED, and a previous version of this comment claimed
    // it was — it stated that on 2.1.269 a case carries
    // `aggregates: { score, passRate, scoreWithout, passRateWithout, delta }`. The one recorded
    // 2.1.269 run carries `aggregates: { score, passRate }` and a single `with` arm: no
    // `scoreWithout`, no `delta`, on any of its twelve cases. So `scoreWithout` and `delta` are
    // read here on the strength of the naming convention `score`/`passRate` establishes, not
    // because any payload in this repo has been seen to carry them. That is a guess, and it is
    // labelled as one rather than dressed as verification — which is the same rule the module's
    // own docstring sets when it says this is the one place that has to learn when the shape
    // moves, and it must say so rather than inventing a number.
    //
    // The consequence is worth stating plainly: the ablation half of case scoring has never
    // parsed a real run. Every one of the frozen run's cases is skipped for want of a delta,
    // so `mean_delta` is null and `sufficient` is false for the only data that exists. Task
    // I-37 owns proving the instrument produces a readable result; `checks/eval-readable.ts`
    // is where both arms, a computable delta and a once-only case name become enforced.
    const agg = asRecord(c.aggregates);
    const withScore = num(agg, "score") ?? num(c, "with_score") ?? num(c, "with");
    const withoutScore = num(agg, "scoreWithout") ?? num(c, "without_score") ?? num(c, "without");
    // A delta the CLI computed is trusted; one it did not is derived, and a case with neither
    // is skipped rather than scored as zero -- zero is a real finding ("this case decides
    // nothing") and must not also mean "unreadable".
    const delta = num(agg, "delta") ?? num(c, "delta") ?? num(c, "mean_delta")
      ?? (withScore !== null && withoutScore !== null ? withScore - withoutScore : null);
    // COST IS READ ABOVE THE DELTA SKIP, and this order is the point of the whole change.
    // A case with no delta is dropped from `cases` below — the frozen 2.1.269 run has no
    // `without` arm, so ALL twelve of its cases are — and its money was still spent. Read
    // after the `continue`, the $4.27 that run cost would be invisible to everything.
    //
    // And there is deliberately no `continue` of its own here. A case missing a cost is a
    // case whose cost is unknown, not a case that did not happen; skipping it for want of a
    // figure the CLI only started printing later would delete the case from the profile to
    // punish the payload for being old.
    const arms = asRecord(c.arms);
    const armRuns: Record<string, unknown>[] = [];
    for (const arm of Object.keys(arms ?? {})) {
      const runs = arms && Array.isArray(arms[arm]) ? arms[arm] as unknown[] : [];
      for (const r of runs) { const o = asRecord(r); if (o) armRuns.push(o); }
    }
    const caseCost = sumOverRuns(armRuns, "costUsd");
    const caseJudge = sumOverRuns(armRuns, "judgeCostUsd");
    if (caseCost !== null) summedCost = (summedCost ?? 0) + caseCost;
    if (caseJudge !== null) summedJudge = (summedJudge ?? 0) + caseJudge;

    // COUNTED ABOVE THE DELTA SKIP, for the same reason the cost is. Below it, a case that
    // cannot be parsed contributes no errors — so the frozen 2.1.269 run, in which NINE runs
    // died when the host slept through them, reported `errored_runs: 0`. The field exists
    // precisely so a half-fallen-over suite cannot be read as a measurement, and it said the
    // suite was clean. A run that errored is a fact about the run; a delta is a fact about the
    // case, and the second being absent does not make the first untrue.
    for (const r of armRuns) if (r.error) errored += 1;

    if (delta === null) continue;

    cases.push({
      name: typeof c.name === "string" ? c.name : "(unnamed)",
      delta,
      with_score: withScore ?? 0,
      without_score: withoutScore ?? 0,
      runs: num(c, "runsPerCase") ?? num(c, "runs") ?? 0,
      discriminating: discriminationOf(delta, withScore ?? 0),
      cost_usd: caseCost,
      judge_cost_usd: caseJudge,
    });
  }

  // The top-level figure when the payload has one, the per-run sum when it does not. On the
  // frozen run the two agree to the cent (4.266979 against 4.266979), which is why either is
  // trusted; the sum is the fallback rather than the answer because the top level is what the
  // CLI itself declares the run cost.
  //
  // BUILT ONCE AND USED BY BOTH RETURNS BELOW, which is what stops the two from drifting: the
  // readable path and the unreadable one report the same four run facts, and a fact can only
  // be dropped from one of them by being deleted from here.
  const facts: RunFacts = {
    cost_usd: rootCost ?? summedCost,
    judge_cost_usd: summedJudge,
    errored_runs: errored,
    partial: root?.partial === true,
  };

  if (!cases.length) {
    return EMPTY("the recorded result carries no case this module could read a delta from", facts);
  }
  return {
    count: cases.length,
    mean_delta: cases.reduce((a, c) => a + c.delta, 0) / cases.length,
    last_run: ranAt,
    cases_digest: casesDigest,
    // ONE case is enough. Cases need no history, which is the whole reason this half exists.
    sufficient: cases.length >= 1,
    cases,
    ...facts,
  };
}
