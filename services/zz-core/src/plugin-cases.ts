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
  /** Why there is nothing, when there is nothing. Never a fabricated delta. */
  reason?: string;
}

const EMPTY = (reason: string): PluginCases => ({
  count: 0, mean_delta: null, last_run: null, cases_digest: "", sufficient: false, cases: [],
  errored_runs: 0, partial: false, reason,
});

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
  const raw = root && Array.isArray(root.cases) ? root.cases : null;
  if (!raw) {
    return EMPTY(
      "the recorded result has no `cases` array — `claude plugin eval --json` has changed shape, " +
      "and this reports that rather than guessing a delta from it");
  }

  const cases: PluginCase[] = [];
  let errored = 0;
  for (const entry of raw) {
    const c = asRecord(entry);
    if (!c) continue;
    const num = (o: Record<string, unknown> | null, k: string): number | null =>
      (o && typeof o[k] === "number" ? o[k] as number : null);

    // WHERE THE NUMBERS ACTUALLY ARE, verified against the CLI rather than assumed. On
    // 2.1.269 a case carries `aggregates: { score, passRate, scoreWithout, passRateWithout,
    // delta }` and `runsPerCase`, and nothing at its top level named `delta`, `with_score` or
    // `with`. This module read only those three, so it found no delta on any case and returned
    // "carries no case this module could read a delta from" for a run that measured perfectly
    // — a real suite reported as an unreadable one. The flat spellings are kept below the
    // nested ones because they cost a line and this schema is not in the CLI's own --help.
    const agg = asRecord(c.aggregates);
    const withScore = num(agg, "score") ?? num(c, "with_score") ?? num(c, "with");
    const withoutScore = num(agg, "scoreWithout") ?? num(c, "without_score") ?? num(c, "without");
    // A delta the CLI computed is trusted; one it did not is derived, and a case with neither
    // is skipped rather than scored as zero -- zero is a real finding ("this case decides
    // nothing") and must not also mean "unreadable".
    const delta = num(agg, "delta") ?? num(c, "delta") ?? num(c, "mean_delta")
      ?? (withScore !== null && withoutScore !== null ? withScore - withoutScore : null);
    if (delta === null) continue;

    // A run that errored or timed out scored 0 and is already inside the arm means above.
    // Counted so the reader can see how much of the suite actually ran.
    const arms = asRecord(c.arms);
    for (const arm of ["with", "without"]) {
      const runs = arms && Array.isArray(arms[arm]) ? arms[arm] as unknown[] : [];
      for (const r of runs) if (asRecord(r)?.error) errored += 1;
    }

    cases.push({
      name: typeof c.name === "string" ? c.name : "(unnamed)",
      delta,
      with_score: withScore ?? 0,
      without_score: withoutScore ?? 0,
      runs: num(c, "runsPerCase") ?? num(c, "runs") ?? 0,
      discriminating: discriminationOf(delta, withScore ?? 0),
    });
  }

  if (!cases.length) {
    return EMPTY("the recorded result carries no case this module could read a delta from");
  }
  return {
    count: cases.length,
    mean_delta: cases.reduce((a, c) => a + c.delta, 0) / cases.length,
    last_run: ranAt,
    cases_digest: casesDigest,
    // ONE case is enough. Cases need no history, which is the whole reason this half exists.
    sufficient: cases.length >= 1,
    cases,
    errored_runs: errored,
    partial: root?.partial === true,
  };
}
