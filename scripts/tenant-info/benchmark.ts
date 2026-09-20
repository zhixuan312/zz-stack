/**
 * benchmark.ts — what a benchmark report must satisfy before anybody may read a release
 * verdict off it. Three pure functions, no I/O, no clock: `validateJudgments` (I-4's
 * judgment-validation export), `evaluateTargets` (I-23's independent pass/fail evaluator) and
 * `validateBenchmarkReport` (I-23's structural validator). The command that assembles a report
 * and writes it into a workspace is `benchmark-run.ts`; the judged dataset's vocabulary and
 * its generator are `judged-dataset.ts`. Both split out of this file during I-23 at the
 * 700-line ceiling, and the FROZEN CHECKS decided which half moved: `checks/tenant-info-qrels-
 * integrity.ts` imports `validateJudgments` from this path and `checks/benchmark-report-
 * completeness.ts` imports `evaluateTargets` from it, so those two stayed and everything no
 * frozen check pins by path is what left.
 *
 * `validateJudgments` is the structural/count/family/ref-shape half of the qrels-integrity
 * technical AC that a coding worker can supply. It never resolves whether a fixture reference
 * exists in a live fixture store, and it never signs a relevance grade; both are the human
 * sign-off (H1), which was recorded on 2026-09-20 under the stakeholder's standing delegation
 * and which states in its own words that no human read the 600 rows.
 *
 * `evaluateTargets` IS THE PART THAT CANNOT BE SATISFIED BY SILENCE. Its whole reason to exist
 * is that a report with no measurements in it must not evaluate to a pass: an absent target is
 * `blocked`, never `0`, never an omission a reader mistakes for success. `evaluateTargets({})`
 * returns all eighteen targets blocked and `passed: false`, which is the state this repository
 * is actually in — no PostgreSQL 17 cluster, no `pg_textsearch` bm25 index and no projected
 * row exists on any reachable cluster, so not one of the eighteen has ever been observed.
 */
import { planCorpora } from "./inventory.ts";
import {
  CATEGORY_COUNTS, DEV_COUNT, HELD_OUT_COUNT, ISOLATION_CATEGORY, LANGUAGE_COUNTS,
  REQUIRED_QUERY_FIELDS, TOTAL_QUERIES, VALID_GRADES, VALID_LANGUAGES, VALID_SPLITS,
  type JudgedQuery, type Qrel,
} from "./judged-dataset.ts";

interface JudgmentValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** `<corpus>-<6-digit ordinal>.txt` — the exact filename `inventory.ts`'s `generateCorpus`
 *  gives a fixture. A qrel's `ref` must have this shape AND name an ordinal that a full-scale
 *  (`scale: 1`) run of that same generator would actually produce, which is what "resolve
 *  fixture references against generated records" means here: the check is against the
 *  generator's own arithmetic, never against a retrieval system's answer. */
const REF_PATTERN = /^([a-z_]+)-(\d{6})\.txt$/;

function isAuthorizedFixtureRef(ref: unknown, corpusSizes: Readonly<Record<string, { records: number }>>): boolean {
  if (typeof ref !== "string") return false;
  const m = REF_PATTERN.exec(ref);
  if (!m) return false;
  const [, corpus, ordinalText] = m;
  const plan = corpusSizes[corpus];
  if (!plan) return false;
  const ordinal = Number(ordinalText);
  return ordinal >= 0 && ordinal < plan.records;
}

/**
 * The structural/count/family/ref-shape half of I-4's technical AC — the half a coding worker
 * can supply. Checks, in order: every query has the required fields and valid enums; the
 * dataset holds the exact category/language counts and the exact 480/120 overall split; each
 * category's own 80/20 split holds; no `family` appears under more than one `split` (leakage);
 * every qrel points at a query that exists and a fixture ref this generator would actually
 * produce, with a grade of 0, 1 or 2; every answerable non-isolation query has at least one
 * relevant (grade > 0) judgment. It never touches a live fixture store and never signs a
 * relevance label — the qrels' `reviewer`/`rationale` fields are carried through, not
 * evaluated for authenticity, because that judgment belongs to H1, not to this function.
 */
export function validateJudgments(
  queries: readonly JudgedQuery[],
  qrels: readonly Qrel[],
): JudgmentValidation {
  const errors: string[] = [];
  const corpusSizes = planCorpora(1);

  const ids = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const splitCounts = new Map<string, number>();
  const categorySplitCounts = new Map<string, Map<string, number>>();
  const familySplits = new Map<string, Set<string>>();

  for (const q of queries ?? []) {
    if (typeof q?.id !== "string" || !q.id) {
      errors.push("a query is missing its id");
      continue;
    }
    if (ids.has(q.id)) errors.push(`duplicate query id "${q.id}"`);
    ids.add(q.id);

    for (const field of REQUIRED_QUERY_FIELDS) {
      if (q[field] === undefined || q[field] === null) {
        errors.push(`query "${q.id}" is missing "${field}"`);
      }
    }
    if (!(q.category in CATEGORY_COUNTS)) {
      errors.push(`query "${q.id}" has an unknown category "${q.category}"`);
    }
    if (!VALID_LANGUAGES.has(q.language)) {
      errors.push(`query "${q.id}" has an invalid language "${q.language}"`);
    }
    if (!VALID_SPLITS.has(q.split)) {
      errors.push(`query "${q.id}" has an invalid split "${q.split}"`);
    }
    if (typeof q.family !== "string" || !q.family) {
      errors.push(`query "${q.id}" is missing its family`);
    }

    categoryCounts.set(q.category, (categoryCounts.get(q.category) ?? 0) + 1);
    languageCounts.set(q.language, (languageCounts.get(q.language) ?? 0) + 1);
    if (VALID_SPLITS.has(q.split)) {
      splitCounts.set(q.split, (splitCounts.get(q.split) ?? 0) + 1);
      if (!categorySplitCounts.has(q.category)) categorySplitCounts.set(q.category, new Map());
      const bySplit = categorySplitCounts.get(q.category)!;
      bySplit.set(q.split, (bySplit.get(q.split) ?? 0) + 1);
    }
    if (typeof q.family === "string" && q.family && VALID_SPLITS.has(q.split)) {
      if (!familySplits.has(q.family)) familySplits.set(q.family, new Set());
      familySplits.get(q.family)!.add(q.split);
    }
  }

  if ((queries ?? []).length !== TOTAL_QUERIES) {
    errors.push(`expected ${TOTAL_QUERIES} queries, got ${(queries ?? []).length}`);
  }
  for (const [category, expected] of Object.entries(CATEGORY_COUNTS)) {
    const actual = categoryCounts.get(category) ?? 0;
    if (actual !== expected) errors.push(`category "${category}" expected ${expected} cases, got ${actual}`);
  }
  for (const [language, expected] of Object.entries(LANGUAGE_COUNTS)) {
    const actual = languageCounts.get(language) ?? 0;
    if (actual !== expected) errors.push(`language "${language}" expected ${expected} cases, got ${actual}`);
  }
  if ((splitCounts.get("dev") ?? 0) !== DEV_COUNT) {
    errors.push(`expected ${DEV_COUNT} "dev" cases, got ${splitCounts.get("dev") ?? 0}`);
  }
  if ((splitCounts.get("held-out") ?? 0) !== HELD_OUT_COUNT) {
    errors.push(`expected ${HELD_OUT_COUNT} "held-out" cases, got ${splitCounts.get("held-out") ?? 0}`);
  }
  for (const [category, total] of Object.entries(CATEGORY_COUNTS)) {
    const expectedDev = Math.round(total * 0.8);
    const expectedHeld = total - expectedDev;
    const bySplit = categorySplitCounts.get(category) ?? new Map<string, number>();
    const actualDev = bySplit.get("dev") ?? 0;
    const actualHeld = bySplit.get("held-out") ?? 0;
    if (actualDev !== expectedDev || actualHeld !== expectedHeld) {
      errors.push(
        `category "${category}" expected an ${expectedDev}/${expectedHeld} dev/held-out split, ` +
        `got ${actualDev}/${actualHeld}`,
      );
    }
  }
  for (const [family, splits] of familySplits) {
    if (splits.size > 1) {
      errors.push(`family "${family}" appears in more than one split (${[...splits].sort().join(", ")})`);
    }
  }
  const heldOutAnswerableLanguages = new Set<string>();
  for (const q of queries ?? []) {
    if (q?.split === "held-out" && q.answerable) heldOutAnswerableLanguages.add(q.language);
  }
  for (const language of VALID_LANGUAGES) {
    if (!heldOutAnswerableLanguages.has(language)) {
      errors.push(`no answerable "held-out" case in language "${language}"`);
    }
  }

  if (!Array.isArray(qrels) || qrels.length === 0) {
    errors.push("qrels is empty");
  }
  const relevantByQuery = new Map<string, boolean>();
  for (const r of qrels ?? []) {
    if (typeof r?.query_id !== "string" || !ids.has(r.query_id)) {
      errors.push(`qrel references unknown query "${r?.query_id}"`);
      continue;
    }
    if (!VALID_GRADES.has(r.grade)) {
      errors.push(`qrel for "${r.query_id}" has an invalid grade ${r.grade}`);
    }
    if (!isAuthorizedFixtureRef(r.ref, corpusSizes)) {
      errors.push(`qrel for "${r.query_id}" has an unresolvable fixture ref "${r.ref}"`);
    }
    if (typeof r.evidence !== "string" || !r.evidence) {
      errors.push(`qrel for "${r.query_id}" is missing its evidence locator`);
    }
    if (typeof r.rationale !== "string" || !r.rationale) {
      errors.push(`qrel for "${r.query_id}" is missing its rationale`);
    }
    if (typeof r.reviewer !== "string" || !r.reviewer) {
      errors.push(`qrel for "${r.query_id}" is missing its reviewer`);
    }
    if (typeof r.grade === "number" && r.grade > 0) relevantByQuery.set(r.query_id, true);
  }
  for (const q of queries ?? []) {
    if (q?.answerable && q.category !== ISOLATION_CATEGORY && !relevantByQuery.get(q.id)) {
      errors.push(`answerable query "${q.id}" (category "${q.category}") has no relevant judgment`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ───────────────── the eighteen release targets, and the independent evaluator ─────────────────

/**
 * The spec's "Fixed capacity and release targets" table, one row per numeric target it fixes,
 * transcribed with its direction. THE DIRECTION IS THE WHOLE POINT: eleven of these are floors
 * a system must reach, four are ceilings it must stay under, and three must be exactly zero —
 * and a comparison written the wrong way round passes a system that fails. The three exact
 * zeros are separate from the ceilings because "at most zero" would accept a negative count,
 * which is not a measurement anybody can make and is therefore a broken instrument.
 *
 * `target` IS A THRESHOLD, NEVER AN OBSERVATION. Nothing in this table was measured; it is the
 * agreement's own numbers, and a report keeps the two in separate fields for exactly that
 * reason. The 0 beside `unauthorized_results` is what the release demands, not something
 * anybody counted.
 */
interface TargetDefinition {
  readonly key: string;
  readonly direction: "at_least" | "at_most" | "exactly";
  readonly target: number;
  readonly unit: string;
  /** What has to actually happen for this target to acquire an observation. Carried into every
   *  blocked entry of a report, so "blocked" names its own remedy instead of just refusing. */
  readonly measured_by: string;
}

const HELD_OUT = "a full-scale run of the held-out answerable slice at quality limit 20";
const REFERENCE_RUN = "the reference workload: 10 clients, 5 q/s for 30 minutes at limit 15, after recorded warm-up";

export const RELEASE_TARGETS: readonly TargetDefinition[] = [
  { key: "recall_at_5", direction: "at_least", target: 0.80, unit: "fraction", measured_by: HELD_OUT },
  { key: "recall_at_20", direction: "at_least", target: 0.95, unit: "fraction", measured_by: HELD_OUT },
  { key: "mrr_at_10", direction: "at_least", target: 0.80, unit: "fraction", measured_by: HELD_OUT },
  { key: "exact_id_resolution", direction: "at_least", target: 1, unit: "fraction",
    measured_by: "the 70 exact-reference cases resolved against the full-scale corpora" },
  { key: "identifier_part_recall_at_5", direction: "at_least", target: 0.95, unit: "fraction",
    measured_by: "the 70 identifier-part cases at quality limit 20" },
  { key: "typo_recall_at_20", direction: "at_least", target: 0.90, unit: "fraction",
    measured_by: "the 70 typo cases at quality limit 20" },
  { key: "no_answer_correct_rate", direction: "at_least", target: 0.90, unit: "fraction",
    measured_by: "the 70 no-answer cases, counting only complete empty responses — a budget-exhausted empty is not a correct negative" },
  { key: "latency_p95_ms", direction: "at_most", target: 750, unit: "ms", measured_by: REFERENCE_RUN },
  { key: "latency_p99_ms", direction: "at_most", target: 2000, unit: "ms", measured_by: REFERENCE_RUN },
  { key: "rebuild_minutes", direction: "at_most", target: 120, unit: "minutes",
    measured_by: "a timed rebuild of all seven declared acceptance corpora, with atomic publication only after parity" },
  { key: "projection_freshness_p99_ms", direction: "at_most", target: 5000, unit: "ms",
    measured_by: "committed-mutation-to-searchable timing on a healthy database during the reference run" },
  { key: "en_recall_at_20", direction: "at_least", target: 0.95, unit: "fraction",
    measured_by: `${HELD_OUT}, English-only slice, with a nonempty denominator` },
  { key: "zh_recall_at_20", direction: "at_least", target: 0.95, unit: "fraction",
    measured_by: `${HELD_OUT}, Chinese-only slice, with a nonempty denominator` },
  { key: "mixed_recall_at_20", direction: "at_least", target: 0.95, unit: "fraction",
    measured_by: `${HELD_OUT}, mixed-language slice, with a nonempty denominator` },
  { key: "unauthorized_results", direction: "exactly", target: 0, unit: "count",
    measured_by: "the isolation suite at acceptance profile over the full-scale corpora" },
  { key: "lost_acknowledged_writes", direction: "exactly", target: 0, unit: "count",
    measured_by: "the cutover rehearsal's acknowledged-write replay after recovery" },
  { key: "silent_truncations", direction: "exactly", target: 0, unit: "count",
    measured_by: "projection of every corpus with zero undisclosed omissions" },
  { key: "semantic_parity", direction: "at_least", target: 1, unit: "fraction",
    measured_by: "a semantic manifest comparison between canonical records and the published projection generation" },
];

export interface TargetOutcome {
  readonly key: string;
  readonly direction: TargetDefinition["direction"];
  readonly target: number;
  readonly unit: string;
  readonly observed: number | null;
  readonly verdict: "passed" | "failed" | "blocked";
  readonly reason: string;
  readonly measured_by: string;
}

export interface TargetEvaluation {
  readonly passed: boolean;
  readonly failed: readonly string[];
  readonly blocked: readonly string[];
  readonly outcomes: readonly TargetOutcome[];
}

/**
 * The independent pass/fail evaluation, over the exact eighteen targets and nothing else.
 *
 * A MISSING OBSERVATION IS `blocked`, NEVER A ZERO AND NEVER AN OMISSION. That is the single
 * property this function exists for: `evaluateTargets({})` returns eighteen blocked keys and
 * `passed: false`, so an empty measurement set cannot be read as a pass by a caller who checks
 * only `failed`. A caller that ignores `blocked` still sees `passed: false`, because `passed`
 * requires both lists empty — there is no arrangement of silence that reaches a green verdict.
 *
 * A NONFINITE OBSERVATION IS `failed`, NOT `blocked`, and the distinction is deliberate: NaN
 * or Infinity means the measuring instrument ran and produced garbage, which is a defect to
 * fix, whereas `blocked` means nobody has measured it yet, which is work to schedule. Filing
 * a broken instrument under "not yet measured" would hide it behind a runbook step.
 *
 * Comparisons are inclusive at the threshold — the agreement says "at least 0.95" and "at most
 * 750 ms", so exactly 0.95 and exactly 750 pass. Keys the table does not name are ignored
 * rather than rejected; a misspelled key still fails, because the target it was meant to be
 * stays missing and therefore blocked.
 */
export function evaluateTargets(measurements: Readonly<Record<string, number>>): TargetEvaluation {
  const given: Readonly<Record<string, unknown>> = measurements ?? {};
  const outcomes: TargetOutcome[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];

  for (const definition of RELEASE_TARGETS) {
    const { key, direction, target, unit, measured_by } = definition;
    const base = { key, direction, target, unit, measured_by };
    if (!Object.hasOwn(given, key)) {
      blocked.push(key);
      outcomes.push({ ...base, observed: null, verdict: "blocked", reason: "no observation was supplied" });
      continue;
    }
    const raw = given[key];
    if (typeof raw !== "number") {
      blocked.push(key);
      outcomes.push({ ...base, observed: null, verdict: "blocked",
        reason: `the supplied value is ${raw === null ? "null" : typeof raw}, which is not an observation` });
      continue;
    }
    if (!Number.isFinite(raw)) {
      failed.push(key);
      outcomes.push({ ...base, observed: raw, verdict: "failed",
        reason: "the observation is nonfinite — the measurement ran and produced no usable number" });
      continue;
    }
    const meets = direction === "at_least" ? raw >= target
      : direction === "at_most" ? raw <= target
      : raw === target;
    if (meets) {
      outcomes.push({ ...base, observed: raw, verdict: "passed", reason: `${raw} ${direction} ${target} ${unit}` });
    } else {
      failed.push(key);
      outcomes.push({ ...base, observed: raw, verdict: "failed",
        reason: `${raw} ${unit} does not meet "${direction} ${target}"` });
    }
  }

  return { passed: failed.length === 0 && blocked.length === 0, failed, blocked, outcomes };
}
