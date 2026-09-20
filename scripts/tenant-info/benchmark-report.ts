/**
 * benchmark-report.ts — the benchmark report itself: how one is assembled from what is
 * actually observable, written into a workspace with its raw evidence, and structurally
 * validated before anybody evaluates a number in it.
 *
 * Split out of benchmark.ts during I-23 at the 700-line ceiling. `checks/benchmark-report-
 * completeness.ts` pins `evaluateTargets` to `benchmark.ts` by path and is not editable, so
 * the evaluator and the judgment validator stayed there and the report — a separate subject,
 * and the only half that touches a filesystem — is what left.
 *
 * NOTHING IN THIS FILE MEASURES ANYTHING, AND THAT IS NOT A GAP THIS TASK LEFT OPEN. There is
 * no PostgreSQL 17 cluster, no built pg_textsearch image, no bm25 index and no projected row
 * reachable from this checkout; migration 070 is deferred on every cluster by construction.
 * So `assembleBenchmarkReport` records the thresholds the agreement fixes, the bindings it can
 * hash off disk, and eighteen blocked targets — each naming what would produce an observation.
 * It never writes a number nobody measured, not as a placeholder and above all not as a zero:
 * a fabricated benchmark report is structurally indistinguishable from a real one, which is
 * the single failure mode this file is built against.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { planCorpora } from "./inventory.ts";
import { evaluateTargets, RELEASE_TARGETS, type TargetEvaluation, type TargetOutcome } from "./benchmark.ts";
import { safeWritePath } from "./workspace.ts";

const TARGET_BY_KEY = new Map(RELEASE_TARGETS.map((t) => [t.key, t]));
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ─────────────── the structural validator: a well-formed report is not a passing one ───────────────

/** The spec's fixed reference workload and reference deployment. A report that restates either
 *  differently did not run the agreed workload, whatever its numbers say.
 *
 *  FROZEN, not merely `as const`. Both objects are placed directly into an assembled report,
 *  so a caller editing the report's `workload.requested` would otherwise be editing the
 *  agreement this validator compares against — and the comparison would then hold by
 *  definition. Measured: the fixture check's "wrong workload" case passed until these were
 *  frozen, because mutating the fixture mutated the constant it was being judged by. */
export const REFERENCE_WORKLOAD = Object.freeze({
  clients: 10, queries_per_second: 5, duration_minutes: 30, limit: 15,
  mix: Object.freeze({ current: 0.8, evidence: 0.1, history: 0.1 }),
});
export const REFERENCE_DEPLOYMENT = Object.freeze({ vcpu: 8, ram_gib: 32, disk_free_gib: 200 });

/** The per-corpus distribution contract: mean 8 KiB within 5%, p95 64 KiB within 5%, exactly
 *  one 1-MiB fixture per 1500 records. Measured per corpus, never as an overall average. */
const MEAN_BYTES = 8192;
const P95_BYTES = 65536;
const RECORDS_PER_ONE_MIB = 1500;
const TOLERANCE = 0.05;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REQUIRED_SLICES = ["held-out-answerable-en", "held-out-answerable-zh", "held-out-answerable-mixed"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFilledString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const within = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= expected * TOLERANCE;

/**
 * `{ok, errors}` for a benchmark report's STRUCTURE, kept deliberately apart from
 * `evaluateTargets`, which judges its numbers. The real command runs this first, and a green
 * result here says nothing whatever about the release: a report can be perfectly well formed
 * and carry eighteen blocked targets, which is exactly the state this repository is in.
 *
 * It refuses six shapes a plausible-looking report can take, each of which would otherwise
 * read as full-scale evidence:
 *
 *   · SYNTHETIC / INTEGRATION-ONLY — a target carries an observation while no filesystem
 *     census, no index census and (for latency) no achieved workload stands behind it. A
 *     number measured against a small fixture set is not a number about the full corpora.
 *   · FORGED SCALE — observed corpus counts whose `method` is a manifest or a declaration.
 *     `testing/tenant-info/manifest.json` is the public DEFINITION of the corpora; copying its
 *     figures into an `observed` field is a restatement of the plan, not a count of files.
 *   · PER-CORPUS DISTRIBUTION — a corpus whose mean/p95 body size or 1-MiB fixture count
 *     misses the contract. Checked corpus by corpus, because an overall average passes while
 *     an individual corpus is wrong, and the agreement names the per-corpus form.
 *   · EMPTY SLICE — a language slice reporting a metric over a denominator of zero. All three
 *     held-out answerable slices must be present; `denominator: null` with a reason is an
 *     honestly unmeasured slice, `denominator: 0` is a metric divided by nothing.
 *   · MISMATCHED QRELS — dataset hashes that differ from the ones H1 approved, or a quality
 *     observation on a report where H1 is not signed. An agent may not sign in H1's place, and
 *     a report may not route around the signature by measuring anyway.
 *   · BAD BINDING — a missing or malformed checkout/module/runtime binding, a target list that
 *     is not exactly the eighteen with their agreed thresholds and directions, or an
 *     `evaluation` block that disagrees with re-running `evaluateTargets` over the report's own
 *     observations.
 */
export function validateBenchmarkReport(report: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(report)) return { ok: false, errors: ["report is not an object"] };

  if (report.schema !== "tenant-info-benchmark/1") errors.push('schema must be "tenant-info-benchmark/1"');
  if (report.profile !== "baseline" && report.profile !== "acceptance") {
    errors.push('profile must be "baseline" or "acceptance"');
  }
  if (!isFilledString(report.generated_at)) errors.push("generated_at is missing");
  if (!isFilledString(report.generated_by)) errors.push("generated_by is missing");

  // ── the eighteen targets, their thresholds and their verdicts ────────────────────────────
  const targets = Array.isArray(report.targets) ? report.targets : [];
  const observed: Record<string, number> = {};
  const seen = new Set<string>();
  if (targets.length !== RELEASE_TARGETS.length) {
    errors.push(`targets must hold exactly ${RELEASE_TARGETS.length} entries, found ${targets.length}`);
  }
  for (const entry of targets) {
    if (!isRecord(entry) || !isFilledString(entry.key)) { errors.push("a target entry has no key"); continue; }
    const key = entry.key;
    const definition = TARGET_BY_KEY.get(key);
    if (!definition) { errors.push(`target "${key}" is not one of the agreed targets`); continue; }
    if (seen.has(key)) errors.push(`target "${key}" appears more than once`);
    seen.add(key);
    if (entry.direction !== definition.direction || entry.target !== definition.target) {
      errors.push(`target "${key}" restates the agreement as ${String(entry.direction)} ${String(entry.target)}, ` +
        `not ${definition.direction} ${definition.target}`);
    }
    if (entry.verdict !== "passed" && entry.verdict !== "failed" && entry.verdict !== "blocked") {
      errors.push(`target "${key}" has no verdict`);
    }
    if (!isFilledString(entry.reason)) errors.push(`target "${key}" gives no reason for its verdict`);
    if (!isFilledString(entry.measured_by)) errors.push(`target "${key}" does not say what would produce an observation`);
    if (entry.observed === null) {
      if (entry.verdict !== "blocked") errors.push(`target "${key}" has no observation but is not blocked`);
    } else if (typeof entry.observed !== "number" || !Number.isFinite(entry.observed)) {
      errors.push(`target "${key}" carries a nonfinite observation`);
    } else {
      if (entry.verdict === "blocked") errors.push(`target "${key}" is blocked while carrying an observation`);
      observed[key] = entry.observed;
    }
  }
  for (const definition of RELEASE_TARGETS) {
    if (!seen.has(definition.key)) errors.push(`target "${definition.key}" is absent from the report`);
  }

  // ── the census, the index and the workload that have to stand behind any observation ─────
  const census = isRecord(report.corpus_census) ? report.corpus_census : null;
  const index = isRecord(report.index_census) ? report.index_census : null;
  const workload = isRecord(report.workload) ? report.workload : null;
  if (!census) errors.push("corpus_census is missing");
  if (!index) errors.push("index_census is missing");
  if (!workload) errors.push("workload is missing");

  let censused = false;
  if (census) {
    const declared = isRecord(census.declared) ? census.declared : null;
    const expected = planCorpora(1);
    if (census.scale !== 1) errors.push("corpus_census.scale must be 1 — a reduced run is not full-scale evidence");
    if (!declared) errors.push("corpus_census.declared is missing");
    else for (const [corpus, plan] of Object.entries(expected)) {
      const row = isRecord(declared[corpus]) ? declared[corpus] : null;
      if (!row) { errors.push(`corpus_census.declared omits "${corpus}"`); continue; }
      if (row.records !== plan.records || row.one_mib_fixtures !== plan.one_mib) {
        errors.push(`corpus_census.declared["${corpus}"] does not match the locked definition ` +
          `(${plan.records} records / ${plan.one_mib} one-MiB fixtures)`);
      }
    }
    if (census.observed === null) {
      if (census.method !== "absent") errors.push('corpus_census.method must be "absent" when nothing was censused');
      if (!isFilledString(census.blocked_reason)) errors.push("corpus_census is empty and says why nowhere");
    } else if (!isRecord(census.observed)) {
      errors.push("corpus_census.observed is neither null nor a per-corpus record");
    } else {
      censused = true;
      if (census.method !== "filesystem-walk") {
        errors.push(`corpus_census.observed was produced by "${String(census.method)}" — observed counts come ` +
          "from walking the generated corpus, never from a manifest declaration");
      }
      for (const [corpus, plan] of Object.entries(expected)) {
        const row = isRecord(census.observed[corpus]) ? census.observed[corpus] : null;
        if (!row) { errors.push(`corpus_census.observed omits "${corpus}"`); continue; }
        const records = typeof row.records === "number" ? row.records : NaN;
        const oneMib = typeof row.one_mib_fixtures === "number" ? row.one_mib_fixtures : NaN;
        const mean = typeof row.mean_bytes === "number" ? row.mean_bytes : NaN;
        const p95 = typeof row.p95_bytes === "number" ? row.p95_bytes : NaN;
        if (!(records >= plan.records)) {
          errors.push(`corpus "${corpus}" holds ${records} records, short of the full-scale ${plan.records}`);
        }
        if (oneMib !== Math.round(records / RECORDS_PER_ONE_MIB)) {
          errors.push(`corpus "${corpus}" has ${oneMib} one-MiB fixtures, not one per ${RECORDS_PER_ONE_MIB} records`);
        }
        if (!within(mean, MEAN_BYTES)) errors.push(`corpus "${corpus}" mean body is ${mean} B, outside 8 KiB ±5%`);
        if (!within(p95, P95_BYTES)) errors.push(`corpus "${corpus}" p95 body is ${p95} B, outside 64 KiB ±5%`);
        if (!Array.isArray(row.histogram) || row.histogram.length === 0) {
          errors.push(`corpus "${corpus}" carries no size histogram`);
        }
        if (!HEX64.test(String(row.aggregate_hash))) errors.push(`corpus "${corpus}" carries no aggregate hash`);
      }
    }
  }

  let indexed = false;
  if (index) {
    const count = index.observed_indexed_artifacts;
    if (count === null) {
      if (!isFilledString(index.blocked_reason)) errors.push("index_census is empty and says why nowhere");
    } else if (typeof count !== "number" || !Number.isFinite(count)) {
      errors.push("index_census.observed_indexed_artifacts is neither null nor a number");
    } else {
      indexed = true;
      if (!censused) errors.push("an indexed count is reported with no source census to substantiate it");
      else {
        const total = Object.values(planCorpora(1)).reduce((sum, plan) => sum + plan.records, 0);
        if (count < total) {
          errors.push(`${count} indexed artifacts is short of the ${total} the seven corpora hold — a full ` +
            "manifest with too few indexed artifacts is not full-scale evidence");
        }
      }
      if (!isFilledString(index.projection_generation)) {
        errors.push("index_census names no projection generation for the indexed count");
      }
    }
  }

  let ran = false;
  if (workload) {
    const requested = isRecord(workload.requested) ? workload.requested : null;
    if (!requested) errors.push("workload.requested is missing");
    else {
      for (const [field, value] of Object.entries(REFERENCE_WORKLOAD)) {
        if (field === "mix") continue;
        if (requested[field] !== value) {
          errors.push(`workload.requested.${field} is ${String(requested[field])}, not the agreed ${value}`);
        }
      }
      const mix = isRecord(requested.mix) ? requested.mix : null;
      if (!mix || mix.current !== 0.8 || mix.evidence !== 0.1 || mix.history !== 0.1) {
        errors.push("workload.requested.mix is not the agreed 80% current / 10% evidence / 10% history");
      }
    }
    if (workload.achieved === null) {
      if (!isFilledString(workload.blocked_reason)) errors.push("workload.achieved is absent and says why nowhere");
    } else if (!isRecord(workload.achieved)) {
      errors.push("workload.achieved is neither null nor a record");
    } else {
      ran = true;
      const achieved = workload.achieved;
      for (const field of ["clients", "queries_per_second", "warm_up_seconds", "observed_queries"]) {
        if (typeof achieved[field] !== "number" || !Number.isFinite(achieved[field])) {
          errors.push(`workload.achieved.${field} is not a recorded number — achieved rate and concurrency are ` +
            "measurements, not a copy of the requested settings");
        }
      }
      if (typeof achieved.observed_queries === "number" && achieved.observed_queries <= 0) {
        errors.push("workload.achieved.observed_queries is zero — no query was actually issued");
      }
    }
  }

  const hardware = isRecord(report.hardware) ? report.hardware : null;
  if (!hardware) errors.push("hardware is missing");
  else {
    const declared = isRecord(hardware.declared) ? hardware.declared : null;
    if (!declared) errors.push("hardware.declared is missing");
    else for (const [field, value] of Object.entries(REFERENCE_DEPLOYMENT)) {
      if (typeof declared[field] !== "number" || (declared[field] as number) < value) {
        errors.push(`hardware.declared.${field} is ${String(declared[field])}, below the reference deployment's ${value}`);
      }
    }
    if (hardware.observed === null && !isFilledString(hardware.blocked_reason)) {
      errors.push("hardware.observed is absent and says why nowhere");
    }
  }

  // ── the bindings: what code, what runtime, which approved dataset ────────────────────────
  const bindings = isRecord(report.bindings) ? report.bindings : null;
  const dataset = bindings && isRecord(bindings.dataset) ? bindings.dataset : null;
  let h1Signed = false;
  if (!bindings) errors.push("bindings is missing");
  if (!dataset) errors.push("bindings.dataset is missing");
  else {
    for (const field of ["queries_jsonl_sha256", "qrels_jsonl_sha256"]) {
      if (!HEX64.test(String(dataset[field]))) errors.push(`bindings.dataset.${field} is not a sha256`);
    }
    for (const field of ["queries_rows", "qrels_rows"]) {
      if (dataset[field] !== 600) errors.push(`bindings.dataset.${field} is ${String(dataset[field])}, not the approved 600`);
    }
    if (dataset.queries_jsonl_sha256 !== dataset.approved_queries_sha256
      || dataset.qrels_jsonl_sha256 !== dataset.approved_qrels_sha256) {
      errors.push("the measured dataset hashes are not the ones H1 approved — this report was run against a " +
        "different judged set, which voids the approval rather than inheriting it");
    }
    if (dataset.matches_approval !== true) errors.push("bindings.dataset.matches_approval is not true");
    h1Signed = dataset.h1_signed === true;
    if (!isFilledString(dataset.approval_path)) errors.push("bindings.dataset names no approval record");
  }

  const code = bindings && isRecord(bindings.code) ? bindings.code : null;
  if (!code) errors.push("bindings.code is missing");
  else {
    if (!HEX40.test(String(code.checkout_sha))) errors.push("bindings.code.checkout_sha is not a commit sha");
    for (const field of ["benchmark_module_sha256", "benchmark_report_module_sha256", "search_module_sha256"]) {
      if (!HEX64.test(String(code[field]))) errors.push(`bindings.code.${field} is not a sha256`);
    }
  }

  const runtime = bindings && isRecord(bindings.runtime) ? bindings.runtime : null;
  const candidateBound = runtime !== null && isRecord(runtime.candidate);
  if (!runtime) errors.push("bindings.runtime is missing");
  else if (!candidateBound && !isFilledString(runtime.blocked_reason)) {
    errors.push("bindings.runtime binds no candidate runtime and says why nowhere");
  }

  // The baseline profile measures the PRESERVED OLD EXECUTABLE. Its missing capabilities are
  // the point of running it, so they are declared rather than quietly scored as zero: a lane
  // the old build never had is unsupported coverage, not a lane that performed badly.
  const coverage = isRecord(report.coverage) ? report.coverage : null;
  if (!coverage) errors.push("coverage is missing");
  else for (const side of ["candidate", "baseline"]) {
    const row = isRecord(coverage[side]) ? coverage[side] : null;
    if (!row) { errors.push(`coverage.${side} is missing`); continue; }
    if (!Array.isArray(row.supported) || !Array.isArray(row.unsupported)) {
      errors.push(`coverage.${side} does not separate supported from unsupported capability`);
    }
  }
  if (report.profile === "baseline" && coverage) {
    const baseline = isRecord(coverage.baseline) ? coverage.baseline : null;
    if (!baseline || !Array.isArray(baseline.unsupported) || baseline.unsupported.length === 0) {
      errors.push("a baseline report declares no unsupported capability — the preserved old executable's missing " +
        "modes are labelled, never improved or erased");
    }
  }

  // ── the slices, where a denominator of zero is the shape that lies ───────────────────────
  const quality = isRecord(report.quality) ? report.quality : null;
  if (!quality) errors.push("quality is missing");
  else {
    const definitions = isRecord(quality.definitions) ? quality.definitions : null;
    if (!definitions) errors.push("quality.definitions is missing");
    else {
      // THE TWO LIMITS ARE THE AGREEMENT'S, NOT THE RUN'S. Quality is scored at limit 20 and
      // latency is measured at limit 15; a run at limit 10 returns fewer candidates and so
      // scores a different recall, which is not a worse result at this workload but a number
      // about a different one. Restating either is how a report compares two things and calls
      // them one.
      if (definitions.quality_limit !== 20) {
        errors.push(`quality.definitions.quality_limit is ${String(definitions.quality_limit)}, not the agreed 20`);
      }
      if (definitions.latency_limit !== 15) {
        errors.push(`quality.definitions.latency_limit is ${String(definitions.latency_limit)}, not the agreed 15`);
      }
    }
    const slices = Array.isArray(quality.slices) ? quality.slices : [];
    const named = new Set<string>();
    for (const slice of slices) {
      if (!isRecord(slice) || !isFilledString(slice.slice)) { errors.push("a quality slice has no name"); continue; }
      named.add(slice.slice);
      const denominator = slice.denominator;
      const metrics = isRecord(slice.metrics) ? slice.metrics : {};
      const scored = Object.values(metrics).some((v) => typeof v === "number");
      if (denominator === null) {
        if (!isFilledString(slice.blocked_reason)) errors.push(`slice "${slice.slice}" is unmeasured and says why nowhere`);
        if (scored) errors.push(`slice "${slice.slice}" reports a metric with no denominator at all`);
      } else if (typeof denominator !== "number" || !Number.isInteger(denominator) || denominator <= 0) {
        errors.push(`slice "${slice.slice}" has a denominator of ${String(denominator)} — a slice is either ` +
          "unmeasured (null, with a reason) or sampled over a positive number of cases, never zero");
      }
    }
    for (const required of REQUIRED_SLICES) {
      if (!named.has(required)) errors.push(`quality.slices omits the required "${required}" slice`);
    }
    const rates = isRecord(quality.rates) ? quality.rates : null;
    if (!rates) errors.push("quality.rates is missing");
    else for (const field of ["no_answer_correct_rate", "false_empty_rate", "incomplete_rate"]) {
      const value = rates[field];
      if (value === null) {
        if (!isFilledString(rates.blocked_reason)) errors.push(`quality.rates.${field} is absent and says why nowhere`);
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`quality.rates.${field} is neither null nor a finite rate`);
      }
    }
  }

  // ── raw evidence, retained so I-25 can re-derive every summary above ─────────────────────
  const raw = Array.isArray(report.raw_evidence) ? report.raw_evidence : null;
  if (!raw || raw.length === 0) {
    errors.push("raw_evidence is empty — even a report that measured nothing records what it looked for");
  } else for (const item of raw) {
    if (!isRecord(item) || !isFilledString(item.path) || !isFilledString(item.describes)) {
      errors.push("a raw_evidence entry names no path or does not say what it is");
    } else if (!HEX64.test(String(item.sha256))) {
      errors.push(`raw_evidence "${item.path}" carries no sha256`);
    }
  }

  // ── an observation with nothing behind it is not full-scale evidence ─────────────────────
  const observedKeys = Object.keys(observed);
  if (observedKeys.length > 0) {
    if (!censused) {
      errors.push(`${observedKeys.length} target(s) carry observations with no filesystem census of the seven ` +
        "corpora behind them — a run against a smaller fixture set is not a measurement of this workload");
    }
    if (!indexed) errors.push("targets carry observations with no indexed-artifact census behind them");
    if (!candidateBound) errors.push("targets carry observations with no candidate runtime bound to them");
    for (const key of ["latency_p95_ms", "latency_p99_ms", "projection_freshness_p99_ms"]) {
      if (Object.hasOwn(observed, key) && !ran) {
        errors.push(`"${key}" is observed with no achieved workload recorded — the reference run's achieved rate ` +
          "and concurrency are what make a latency number about this workload");
      }
    }
    if (!h1Signed) {
      errors.push("targets carry observations while H1 is not signed — a missing signature blocks the quality " +
        "verdict, it does not license measuring around it");
    }
  }

  // ── the evaluation block must be what evaluateTargets actually returns ───────────────────
  const evaluation = isRecord(report.evaluation) ? report.evaluation : null;
  if (!evaluation) errors.push("evaluation is missing");
  else {
    const recomputed = evaluateTargets(observed);
    const same = (a: unknown, b: readonly string[]): boolean =>
      Array.isArray(a) && a.length === b.length && [...a].sort().join() === [...b].sort().join();
    if (evaluation.passed !== recomputed.passed) {
      errors.push(`evaluation.passed is ${String(evaluation.passed)}; re-running evaluateTargets over this ` +
        `report's own observations gives ${recomputed.passed}`);
    }
    if (!same(evaluation.failed, recomputed.failed)) errors.push("evaluation.failed is not what the observations give");
    if (!same(evaluation.blocked, recomputed.blocked)) errors.push("evaluation.blocked is not what the observations give");
    const expectedVerdict = recomputed.blocked.length > 0 ? "blocked" : recomputed.failed.length > 0 ? "failed" : "passed";
    if (report.release_verdict !== expectedVerdict) {
      errors.push(`release_verdict is "${String(report.release_verdict)}" where the targets give "${expectedVerdict}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ────────────────────────── assembling and writing the report ──────────────────────────

export type BenchmarkProfile = "baseline" | "acceptance";

/**
 * The files an operator drops into `<workspace>/benchmark-inputs/<profile>/` after a real
 * reference run, one per section of the report. Each is optional and each absence becomes a
 * blocked section naming what is missing — which is how every section of this repository's
 * own report is currently filled. `deploy/BENCHMARK-MEASUREMENT.md` is the procedure that
 * produces them.
 */
const INPUT_FILES = {
  measurements: "measurements.json", census: "corpus-census.json", index: "index-census.json",
  workload: "workload.json", hardware: "hardware.json", runtime: "runtime.json", quality: "quality.json",
} as const;

interface LoadedInput { readonly name: string; readonly path: string; readonly found: boolean; readonly sha256: string | null }

const sha256 = (buffer: Buffer | string): string => createHash("sha256").update(buffer).digest("hex");

function readJsonIfPresent(path: string): { value: unknown; evidence: LoadedInput } {
  const name = path.split("/").slice(-2).join("/");
  if (!existsSync(path)) return { value: null, evidence: { name, path, found: false, sha256: null } };
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString("utf8")), evidence: { name, path, found: true, sha256: sha256(bytes) } };
}

const repoSha256 = (relative: string): string | null => {
  const full = join(repoRoot, relative);
  return existsSync(full) ? sha256(readFileSync(full)) : null;
};

/** `git rev-parse HEAD`, or null where git cannot answer. A null becomes a failed code
 *  binding rather than a fabricated sha — an invented commit id is the same class of lie as
 *  an invented latency. */
function checkoutSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch { return null; }
}

const blocked = (reason: string) => reason;

/**
 * Builds the report for one profile out of what is actually on disk. Every section is either
 * an observation loaded from an operator-supplied input file, or `null` beside the reason it
 * is missing. There is no third state, and in particular there is no zero: "missing
 * performance observations do not default to zero" is the contract's sentence and this is
 * where it is kept.
 */
function assembleBenchmarkReport(
  workspaceReal: string, profile: BenchmarkProfile,
): { report: Record<string, unknown>; evidence: readonly LoadedInput[] } {
  const inputDir = join(workspaceReal, "benchmark-inputs", profile);
  const loaded: LoadedInput[] = [];
  const section = (key: keyof typeof INPUT_FILES): unknown => {
    const { value, evidence } = readJsonIfPresent(join(inputDir, INPUT_FILES[key]));
    loaded.push(evidence);
    return value;
  };
  const measurements = section("measurements");
  const census = section("census");
  const index = section("index");
  const workload = section("workload");
  const hardware = section("hardware");
  const runtime = section("runtime");
  const quality = section("quality");

  const queriesBytes = readFileSync(join(repoRoot, "testing/tenant-info/queries.jsonl"));
  const qrelsBytes = readFileSync(join(repoRoot, "testing/tenant-info/qrels.jsonl"));
  const rows = (bytes: Buffer): number => bytes.toString("utf8").trim().split("\n").length;
  const approvalPath = join(workspaceReal, "artifacts/tenant-info-v4/qrels-approval.json");
  const approval = readJsonIfPresent(approvalPath);
  loaded.push(approval.evidence);
  const subject = isRecord(approval.value) && isRecord(approval.value.subject) ? approval.value.subject : null;
  const approvedHash = (file: string): string | null => {
    const row = subject && isRecord(subject[file]) ? subject[file] : null;
    return row && typeof row.sha256 === "string" ? row.sha256 : null;
  };
  const h1Signed = isRecord(approval.value) && approval.value.decision === "approved";

  const supplied: Record<string, number> = {};
  if (isRecord(measurements)) {
    for (const definition of RELEASE_TARGETS) {
      const value = measurements[definition.key];
      if (typeof value === "number") supplied[definition.key] = value;
    }
  }
  const evaluation: TargetEvaluation = evaluateTargets(supplied);
  const targets: TargetOutcome[] = [...evaluation.outcomes];

  const declared: Record<string, { records: number; one_mib_fixtures: number }> = {};
  for (const [corpus, plan] of Object.entries(planCorpora(1))) {
    declared[corpus] = { records: plan.records, one_mib_fixtures: plan.one_mib };
  }

  const NOTHING_RAN = "no reference run has been executed from this checkout: there is no PostgreSQL 17 cluster, " +
    "no built pg_textsearch image and no projected row to measure against";

  const report: Record<string, unknown> = {
    schema: "tenant-info-benchmark/1",
    criterion: "AC-6.2 / AC-5.2",
    profile,
    generated_at: new Date().toISOString(),
    generated_by: `npm run tenant-info -- benchmark --profile ${profile}`,
    _header: [
      "Every `observed` field in this report is either a number loaded from an operator-supplied",
      "input file under benchmark-inputs/, or null beside the reason nothing was measured. No",
      "figure here was estimated, defaulted or filled in to make the shape look complete. A",
      "release verdict of \"blocked\" means the measurement has not happened — it does not mean",
      "the system failed, and it must not be read as one. deploy/BENCHMARK-MEASUREMENT.md is the",
      "procedure that turns each blocked target into an observation.",
    ],
    release_verdict: evaluation.blocked.length > 0 ? "blocked" : evaluation.failed.length > 0 ? "failed" : "passed",
    corpus_census: isRecord(census) ? census : {
      method: "absent", scale: 1, declared, observed: null,
      blocked_reason: blocked(`${NOTHING_RAN}; no full-scale corpus has been generated, so no file walk can count one`),
    },
    index_census: isRecord(index) ? index : {
      method: "absent", observed_indexed_artifacts: null, projection_generation: null,
      blocked_reason: blocked(`${NOTHING_RAN}; migration 070 is deferred on every cluster, so no artifact is indexed`),
    },
    sizes: { passage_bytes: null, index_bytes: null,
      blocked_reason: blocked("passage and index sizes are properties of a built index, and none exists") },
    workload: isRecord(workload) ? workload : {
      requested: REFERENCE_WORKLOAD, achieved: null,
      blocked_reason: blocked(`${NOTHING_RAN}; achieved rate and concurrency are measured during the run, not declared`),
    },
    hardware: isRecord(hardware) ? hardware : {
      declared: REFERENCE_DEPLOYMENT, observed: null,
      blocked_reason: blocked("the reference host's actual CPU, disk and OS are recorded on that host; this " +
        "checkout is a developer laptop and is explicitly not the machine"),
    },
    bindings: {
      dataset: {
        queries_jsonl_sha256: sha256(queriesBytes), queries_rows: rows(queriesBytes),
        qrels_jsonl_sha256: sha256(qrelsBytes), qrels_rows: rows(qrelsBytes),
        approval_path: "artifacts/tenant-info-v4/qrels-approval.json",
        approved_queries_sha256: approvedHash("queries.jsonl"), approved_qrels_sha256: approvedHash("qrels.jsonl"),
        matches_approval: sha256(queriesBytes) === approvedHash("queries.jsonl")
          && sha256(qrelsBytes) === approvedHash("qrels.jsonl"),
        h1_signed: h1Signed,
      },
      code: {
        checkout_sha: checkoutSha(),
        benchmark_module_sha256: repoSha256("scripts/tenant-info/benchmark.ts"),
        // The VALIDATOR is bound too, not just the evaluator. A change to what counts as a
        // well-formed report changes what this report means, and without this hash that change
        // is invisible to the binding I-25 re-checks.
        benchmark_report_module_sha256: repoSha256("scripts/tenant-info/benchmark-report.ts"),
        search_module_sha256: repoSha256("services/zz-core/src/tenant-info/search.ts"),
      },
      runtime: isRecord(runtime) ? runtime : {
        candidate: null, baseline: null,
        blocked_reason: blocked("no candidate image was built and I-2's preserved baseline image is not present " +
          "in this workspace, so neither runtime identity can be bound"),
      },
    },
    coverage: {
      candidate: {
        supported: ["four composed retrieval lanes", "three scopes", "mode-aware grammar", "cursor and freshness bounds"],
        unsupported: ["lexical bm25 ranking — no bm25 index exists on any cluster; migration 070 is deferred",
          "the live knowledge_search handler is deliberately not repointed at these tables"],
      },
      baseline: {
        supported: ["the preserved old executable's own search path, as captured by I-2"],
        unsupported: ["scoped corpora", "identifier-part and typo handling", "history scope",
          "every capability this initiative adds — absent from the old build by construction, never scored as a miss"],
      },
    },
    quality: isRecord(quality) ? quality : {
      definitions: {
        recall_at_k: "distinct required relevant refs in the first k DISPLAYED results / all judged relevant refs, " +
          "arithmetic mean over the named answerable non-isolation slice",
        mrr_at_10: "reciprocal rank of the first relevant result within 10, zero on miss",
        ndcg_at_10: "gain 2^grade-1, discount log2(rank+1), against that query's ideal ordering",
        relevant_grades: [1, 2], quality_limit: 20, latency_limit: 15,
        omissions: "a response-budget omission counts as a miss, never as an undisplayed candidate scored anyway",
        no_answer_cases: "excluded from every quality denominator",
      },
      slices: REQUIRED_SLICES.map((slice) => ({
        slice, denominator: null, metrics: {},
        blocked_reason: blocked(`${NOTHING_RAN}; this slice has never been sampled`),
      })),
      rates: { no_answer_correct_rate: null, false_empty_rate: null, incomplete_rate: null,
        blocked_reason: blocked(NOTHING_RAN) },
    },
    raw_evidence: [],
    targets,
    evaluation: { passed: evaluation.passed, failed: [...evaluation.failed], blocked: [...evaluation.blocked] },
  };
  return { report, evidence: loaded };
}

export interface BenchmarkReceipt {
  readonly verb: "benchmark";
  readonly profile: BenchmarkProfile;
  readonly ran_at: string;
  readonly report_path: string;
  readonly raw_evidence_path: string;
  readonly structurally_valid: boolean;
  readonly structure_errors: readonly string[];
  readonly release_verdict: unknown;
  readonly failed: readonly string[];
  readonly blocked: readonly string[];
  readonly ok: boolean;
}

/**
 * The `benchmark` verb. Assembles the report, retains the raw evidence beside it, validates
 * the structure, and only then reads a verdict off the numbers.
 *
 * `ok` REQUIRES BOTH, AND THAT IS THE POINT OF THE WHOLE TASK. A structurally valid report is
 * not a passing one: this repository's own report validates cleanly and carries eighteen
 * blocked targets, and the verb exits nonzero on it. A caller that treated "the command
 * produced a well-formed report" as success would ship on a file that measured nothing.
 */
export function runBenchmark(workspaceReal: string, profile: BenchmarkProfile): BenchmarkReceipt {
  const { report, evidence } = assembleBenchmarkReport(workspaceReal, profile);

  const rawDir = safeWritePath(workspaceReal, "raw", "benchmark", profile);
  mkdirSync(rawDir, { recursive: true });
  const rawPath = safeWritePath(workspaceReal, "raw", "benchmark", profile, "inputs.json");
  const rawBody = `${JSON.stringify({
    profile,
    captured_at: report.generated_at,
    describes: "every measurement input this run looked for, whether it was there, and its hash if it was",
    inputs: evidence,
  }, null, 2)}\n`;
  writeFileSync(rawPath, rawBody);
  report.raw_evidence = [{
    path: `raw/benchmark/${profile}/inputs.json`, sha256: sha256(rawBody),
    describes: "the measurement inputs this run resolved, found or absent — I-25 re-derives every summary above " +
      "from these, and an absent input is why the matching section is blocked",
  }];

  const structure = validateBenchmarkReport(report);
  const evaluation = isRecord(report.evaluation) ? report.evaluation : {};
  const failed = Array.isArray(evaluation.failed) ? evaluation.failed as string[] : [];
  const stillBlocked = Array.isArray(evaluation.blocked) ? evaluation.blocked as string[] : [];

  const fileName = profile === "acceptance" ? "benchmark.json" : "benchmark-baseline.json";
  const reportDir = safeWritePath(workspaceReal, "artifacts", "tenant-info-v4");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = safeWritePath(workspaceReal, "artifacts", "tenant-info-v4", fileName);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return {
    verb: "benchmark", profile, ran_at: String(report.generated_at),
    report_path: `artifacts/tenant-info-v4/${fileName}`,
    raw_evidence_path: `raw/benchmark/${profile}/inputs.json`,
    structurally_valid: structure.ok, structure_errors: structure.errors,
    release_verdict: report.release_verdict, failed, blocked: stillBlocked,
    ok: structure.ok && failed.length === 0 && stillBlocked.length === 0,
  };
}
