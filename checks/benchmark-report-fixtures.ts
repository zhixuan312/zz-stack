// Drives `validateBenchmarkReport` over synthetic fixtures built here. It never opens the real
// private report, which lives outside this checkout and which no ordinary gate check may read.
//
// Each rejection mutates exactly one field of a fixture that otherwise validates: a rejection
// test whose fixture was broken in two ways passes while the rule under test does nothing.
import assert from "node:assert/strict";

import { evaluateTargets, RELEASE_TARGETS } from "../scripts/tenant-info/benchmark.ts";
import {
  REFERENCE_DEPLOYMENT, REFERENCE_WORKLOAD, validateBenchmarkReport,
} from "../scripts/tenant-info/benchmark-report.ts";

const HEX = "a".repeat(64);
const SHA = "b".repeat(40);
const FULL_SCALE: Record<string, number> = {
  primary_current: 150000, primary_evidence: 150000, primary_history: 150000,
  other_team_a: 150000, other_team_b: 150000, shared_current: 15000, shared_evidence: 15000,
};
const TOTAL_RECORDS = Object.values(FULL_SCALE).reduce((a, b) => a + b, 0);
const SLICES = ["held-out-answerable-en", "held-out-answerable-zh", "held-out-answerable-mixed"];

const declared = (): Record<string, unknown> => Object.fromEntries(
  Object.entries(FULL_SCALE).map(([c, n]) => [c, { records: n, one_mib_fixtures: n / 1500 }]));

const observedCorpora = (): Record<string, unknown> => Object.fromEntries(
  Object.entries(FULL_SCALE).map(([c, n]) => [c, {
    records: n, one_mib_fixtures: n / 1500, mean_bytes: 8192, p95_bytes: 65536,
    histogram: [[0, n]], aggregate_hash: HEX,
  }]));

/** A report whose every target is observed exactly at its threshold, with the full-scale
 *  census, indexed count, achieved workload and bound runtime that have to stand behind an
 *  observation. This is the fixture each rejection mutates one field of. */
function measured(): Record<string, unknown> {
  const targets = RELEASE_TARGETS.map((t) => ({
    key: t.key, direction: t.direction, target: t.target, unit: t.unit,
    observed: t.target, verdict: "passed", reason: "at the threshold", measured_by: t.measured_by,
  }));
  return {
    schema: "tenant-info-benchmark/1", criterion: "AC-6.2 / AC-5.2", profile: "acceptance",
    generated_at: "2026-09-20T00:00:00.000Z", generated_by: "a synthetic fixture", release_verdict: "passed",
    corpus_census: { method: "filesystem-walk", scale: 1, declared: declared(), observed: observedCorpora(), blocked_reason: null },
    index_census: { method: "index-scan", observed_indexed_artifacts: TOTAL_RECORDS, projection_generation: "gen-1", blocked_reason: null },
    sizes: { passage_bytes: 1, index_bytes: 1, blocked_reason: null },
    workload: { requested: { ...REFERENCE_WORKLOAD, mix: { ...REFERENCE_WORKLOAD.mix } }, achieved: { clients: 10, queries_per_second: 5, warm_up_seconds: 120, observed_queries: 9000 }, blocked_reason: null },
    hardware: { declared: { ...REFERENCE_DEPLOYMENT }, observed: { cpu: "synthetic" }, blocked_reason: null },
    bindings: {
      dataset: {
        queries_jsonl_sha256: HEX, qrels_jsonl_sha256: HEX, queries_rows: 600, qrels_rows: 600,
        approval_path: "artifacts/tenant-info-v4/qrels-approval.json",
        approved_queries_sha256: HEX, approved_qrels_sha256: HEX, matches_approval: true, h1_signed: true,
      },
      code: { checkout_sha: SHA, benchmark_module_sha256: HEX, benchmark_report_module_sha256: HEX, search_module_sha256: HEX },
      runtime: { candidate: { image: "synthetic" }, baseline: { image: "synthetic" }, blocked_reason: null },
    },
    coverage: { candidate: { supported: ["all"], unsupported: [] }, baseline: { supported: [], unsupported: ["scoped corpora"] } },
    quality: {
      definitions: { quality_limit: 20, latency_limit: 15 },
      slices: SLICES.map((slice) => ({ slice, denominator: 40, metrics: { recall_at_20: 0.95 }, blocked_reason: null })),
      rates: { no_answer_correct_rate: 0.9, false_empty_rate: 0, incomplete_rate: 0, blocked_reason: null },
    },
    raw_evidence: [{ path: "raw/benchmark/acceptance/inputs.json", sha256: HEX, describes: "synthetic" }],
    targets,
    evaluation: { passed: true, failed: [], blocked: [] },
  };
}

/** The same report with nothing measured: it must validate while still evaluating to blocked.
 *  Rejecting it would make a report well formed only by carrying numbers. */
function empty(): Record<string, unknown> {
  const report = measured();
  report.release_verdict = "blocked";
  report.targets = RELEASE_TARGETS.map((t) => ({
    key: t.key, direction: t.direction, target: t.target, unit: t.unit,
    observed: null, verdict: "blocked", reason: "no observation was supplied", measured_by: t.measured_by,
  }));
  report.corpus_census = { method: "absent", scale: 1, declared: declared(), observed: null, blocked_reason: "no corpus generated" };
  report.index_census = { method: "absent", observed_indexed_artifacts: null, projection_generation: null, blocked_reason: "no index" };
  report.workload = { requested: { ...REFERENCE_WORKLOAD, mix: { ...REFERENCE_WORKLOAD.mix } }, achieved: null, blocked_reason: "no run" };
  report.hardware = { declared: { ...REFERENCE_DEPLOYMENT }, observed: null, blocked_reason: "not the reference host" };
  report.evaluation = { passed: false, failed: [], blocked: RELEASE_TARGETS.map((t) => t.key) };
  const quality = report.quality as Record<string, unknown>;
  quality.slices = SLICES.map((slice) => ({ slice, denominator: null, metrics: {}, blocked_reason: "never sampled" }));
  quality.rates = { no_answer_correct_rate: null, false_empty_rate: null, incomplete_rate: null, blocked_reason: "no run" };
  return report;
}

const rejects = (label: string, mutate: (r: Record<string, unknown>) => void, expect: RegExp): void => {
  const report = measured();
  mutate(report);
  const result = validateBenchmarkReport(report);
  assert.equal(result.ok, false, `${label}: validated when it should have been refused`);
  assert.ok(result.errors.some((e) => expect.test(e)),
    `${label}: refused, but for none of the expected reasons — ${result.errors.join("; ")}`);
};

const path = (report: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  keys.reduce((node, key) => node[key] as Record<string, unknown>, report);

assert.deepEqual(validateBenchmarkReport(measured()).errors, []);
assert.equal(validateBenchmarkReport(empty()).ok, true);

// The six shapes the plan names.
rejects("synthetic integration-only", (r) => { path(r, "corpus_census").observed = null; path(r, "corpus_census").method = "absent"; path(r, "corpus_census").blocked_reason = "none"; },
  /no filesystem census/);
rejects("forged scale", (r) => { path(r, "corpus_census").method = "manifest"; }, /never from a manifest declaration/);
rejects("per-corpus distribution", (r) => { (path(r, "corpus_census", "observed", "shared_current")).mean_bytes = 4096; },
  /mean body is 4096 B, outside 8 KiB/);
rejects("empty slice", (r) => { ((path(r, "quality").slices as Record<string, unknown>[])[1]).denominator = 0; },
  /never zero/);
rejects("mismatched qrels", (r) => { path(r, "bindings", "dataset").approved_queries_sha256 = "c".repeat(64); },
  /not the ones H1 approved/);
rejects("bad binding", (r) => { delete path(r, "bindings", "code").checkout_sha; }, /checkout_sha is not a commit sha/);

// And the errors the contract names separately.
rejects("reduced actual corpus", (r) => { (path(r, "corpus_census", "observed", "primary_current")).records = 1000; },
  /short of the full-scale 150000/);
rejects("too few indexed artifacts", (r) => { path(r, "index_census").observed_indexed_artifacts = 12; },
  /not full-scale evidence/);
rejects("absent target", (r) => { r.targets = (r.targets as unknown[]).slice(1); }, /is absent from the report/);
rejects("nonfinite observation", (r) => { ((r.targets as Record<string, unknown>[])[7]).observed = "NaN"; },
  /nonfinite observation/);
rejects("wrong workload", (r) => { path(r, "workload", "requested").duration_minutes = 2; }, /not the agreed 30/);
rejects("requested settings copied as achieved", (r) => { path(r, "workload").achieved = { ...REFERENCE_WORKLOAD }; },
  /achieved rate and concurrency are measurements/);
rejects("H1 unsigned while measuring anyway", (r) => { path(r, "bindings", "dataset").h1_signed = false; },
  /does not license measuring around it/);
rejects("a restated threshold", (r) => { ((r.targets as Record<string, unknown>[])[7]).target = 99999; },
  /restates the agreement/);
rejects("a verdict the numbers do not give", (r) => { ((r.targets as Record<string, unknown>[])[0]).observed = 0; },
  /evaluation\.passed is true/);
rejects("a baseline hiding its missing modes", (r) => {
  r.profile = "baseline"; path(r, "coverage", "baseline").unsupported = [];
}, /never improved or erased/);
rejects("a run scored at another limit", (r) => { path(r, "quality", "definitions").quality_limit = 10; },
  /quality_limit is 10, not the agreed 20/);
rejects("latency measured at another limit", (r) => { path(r, "quality", "definitions").latency_limit = 50; },
  /latency_limit is 50, not the agreed 15/);
rejects("silence about the raw evidence", (r) => { r.raw_evidence = []; }, /records what it looked for/);

// An empty report that claims to have passed is the one shape this check exists to stop.
const lying = empty();
lying.evaluation = { passed: true, failed: [], blocked: [] };
lying.release_verdict = "passed";
assert.equal(validateBenchmarkReport(lying).ok, false);

// Infinity on a floor is the nonfinite case the frozen check cannot see: it tests NaN, which
// fails every comparison anyway, so deleting `evaluateTargets`'s finiteness guard leaves that
// check green. `Infinity >= 0.80` is true, so a target whose instrument overflowed would read
// as comfortably met.
const atLeast = RELEASE_TARGETS.filter((t) => t.direction === "at_least").map((t) => t.key);
const overflowed = Object.fromEntries(RELEASE_TARGETS.map((t) => [t.key, t.target]));
for (const key of atLeast) {
  const result = evaluateTargets({ ...overflowed, [key]: Number.POSITIVE_INFINITY });
  assert.equal(result.passed, false, `${key}: an infinite observation was read as meeting the target`);
  assert.ok(result.failed.includes(key), `${key}: an infinite observation was not failed`);
}
// An empty measurement set blocks all eighteen targets and passes nothing.
const nothing = evaluateTargets({});
assert.equal(nothing.passed, false);
assert.deepEqual([...nothing.blocked].sort(), RELEASE_TARGETS.map((t) => t.key).sort());
assert.deepEqual(nothing.failed, []);

console.log("benchmark-report-fixtures: ok");
