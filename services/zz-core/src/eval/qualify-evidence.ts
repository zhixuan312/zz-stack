/**
 * Evidence gathering for `evaluator_qualify`: anchors, planted faults, controls,
 * stability and labels.
 *
 *   - Anchors, faults and controls are the measure's OWN known-answer texts, declared in the
 *     protocol as `definition.qualification.anchors: [{ id, role, text, expected }]`
 *     (`MeasureQualification` in `@zz/contracts`). Each is asked the measure's own question —
 *     the evaluator version is the measure's — and passes when the answer is `expected`.
 *   - `role: "anchor"` feeds the anchor pass rate, `"fault"` (a good example with one planted
 *     defect) the fault kill rate, `"control"` (an artifact of another kind) the control catch rate.
 *   - Every entry is asked three times, and passes only when all three answers are its
 *     `expected` — an unclear answer is a miss. Stability is the share of entries whose three
 *     answers agree.
 *   - Labels come only through the protocol's `qualification.labelMappings`, matched by this
 *     evaluator's own `stable_key` — see `parseLabelMappings`/`mappingFor` — and pair a decided
 *     `zz.eval_finding` with the evaluator's answers of the same measure in the same run, which
 *     `evaluation_assess` records in `zz.eval_assessment` (`labelEvidence`).
 */
import type pg from "pg";

import type { MeasureAnchor } from "@zz/contracts";

import type { EvaluatorAssessmentResult } from "../semantic.js";
import type { LadderCounts, LadderLabels } from "./qualify-ladder.js";

type Answer = Pick<EvaluatorAssessmentResult, "answer_kind" | "reading" | "distribution">;

/** What one asked answer reduces to, in whatever vocabulary the evaluator's own kind speaks: a
 *  `noul`'s `yes`/`no` reading (never `unclear`/`unavailable` — those match no anchor's expected
 *  string by construction), or a `choice`/`score`'s highest-probability option. `null` means no
 *  comparable answer came back — a distribution-less choice/score, or an unavailable noul. */
function normalizeAnswer(r: Answer): string | null {
  if (r.answer_kind === "noul") return r.reading === "yes" || r.reading === "no" ? r.reading : null;
  if (!r.distribution) return null;
  const top = Object.entries(r.distribution).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/** One known-answer text as it came back: which entry, what it expected, what the evaluator said.
 *  `role: "stability"` rows are an entry's second and third asks. */
export interface AnchorResult {
  readonly id: string;
  readonly role: MeasureAnchor["role"] | "stability";
  readonly expected: string;
  readonly got: string | null;
}

/** anchors + planted faults + controls + stability, the four counted-evidence categories the
 *  ladder reads, from the measure's declared texts. `ask` is the one model call — `qualify.ts`
 *  hands in one that asks the measure's evaluator version and keeps every answer, by `index`, for
 *  its own transaction to write; a check hands in a stub. Nothing here touches a database.
 *
 *  The asks are independent, so they run `ASK_WIDTH` at a time, started in declared order: entry
 *  `e`'s ask `i` is index `3e + i`, and the results are read back in that order whatever order the
 *  answers arrive in. */
export async function gatherCountedEvidence(opts: {
  anchors: readonly MeasureAnchor[];
  ask: (text: string, index: number) => Promise<Answer>;
}): Promise<{
  counts: { anchors: LadderCounts; planted_faults: LadderCounts; controls: LadderCounts; stability: LadderCounts };
  results: AnchorResult[];
}> {
  const results: AnchorResult[] = [];
  const empty = { passed: 0, total: 0 };
  const first = opts.anchors.find((a) => a.role === "anchor");
  if (!first) {
    return { counts: { anchors: empty, planted_faults: empty, controls: empty, stability: empty }, results };
  }

  const texts = opts.anchors.flatMap((a) => Array.from({ length: ASKS_PER_ENTRY }, () => a.text));
  const got: (string | null)[] = new Array(texts.length);
  for (let start = 0; start < texts.length; start += ASK_WIDTH) {
    await Promise.all(texts.slice(start, start + ASK_WIDTH).map(async (text, k) => {
      got[start + k] = normalizeAnswer(await opts.ask(text, start + k));
    }));
  }

  const tally = { anchor: { passed: 0, total: 0 }, fault: { passed: 0, total: 0 }, control: { passed: 0, total: 0 } };
  const stability = { passed: 0, total: 0 };
  for (const [e, a] of opts.anchors.entries()) {
    const answers = got.slice(e * ASKS_PER_ENTRY, (e + 1) * ASKS_PER_ENTRY);
    answers.forEach((answer, i) =>
      results.push({ id: a.id, role: i === 0 ? a.role : "stability", expected: a.expected, got: answer }));
    tally[a.role].total += 1;
    if (answers.every((got) => got === a.expected)) tally[a.role].passed += 1;
    stability.total += 1;
    if (answers.every((got) => got === answers[0])) stability.passed += 1;
  }

  return {
    counts: { anchors: tally.anchor, planted_faults: tally.fault, controls: tally.control, stability },
    results,
  };
}

/** How many times each known-answer text is asked. */
const ASKS_PER_ENTRY = 3;
/** How many asks are in flight at once — the width `spec-gate.ts` and `review-acceptance.ts` ask
 *  their typed-service questions at. */
const ASK_WIDTH = 8;

// ---------------------------------------------------------------------------------------------
// Labels — selection is pure; the query
// that feeds it is `labelEvidence` below.

interface LabelMapping { readonly evaluator: string; readonly applied: string; readonly rejected: string }

/** `QualificationPolicy.labelMappings` narrowed to entries this file can use: a bare string names
 *  no evaluator and contributes nothing (a protocol may still list one for documentation), and an
 *  object missing any of the three fields is dropped rather than guessed at. */
export function parseLabelMappings(raw: readonly unknown[]): LabelMapping[] {
  const out: LabelMapping[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.evaluator === "string" && typeof r.applied === "string" && typeof r.rejected === "string") {
      out.push({ evaluator: r.evaluator, applied: r.applied, rejected: r.rejected });
    }
  }
  return out;
}

export function mappingFor(mappings: readonly LabelMapping[], stableKey: string): LabelMapping | null {
  return mappings.find((m) => m.evaluator === stableKey) ?? null;
}

interface LabelRow {
  readonly finding_id: string;
  readonly decision: "applied" | "rejected";
  readonly answer_kind: "noul" | "choice" | "score";
  readonly reading: "yes" | "no" | "unclear" | "unavailable" | null;
  readonly distribution: Readonly<Record<string, number>> | null;
}

/** Pure: a mapping and the correlated rows a live query found, reduced to `{n, tpr, tnr}`. `n` is
 *  the decided findings the rows pair, one label each however many answers its run holds; the
 *  rates are over the pairs. `null` whenever either class (applied or rejected) is empty — a rate
 *  computed over zero examples of the other class is not a rate. */
function computeLabelStats(rows: readonly LabelRow[], mapping: LabelMapping): LadderLabels | null {
  if (!rows.length) return null;
  const applied = rows.filter((r) => r.decision === "applied");
  const rejected = rows.filter((r) => r.decision === "rejected");
  if (!applied.length || !rejected.length) return null;
  const answerOf = (r: LabelRow): string | null => (
    normalizeAnswer({ answer_kind: r.answer_kind, reading: r.reading, distribution: r.distribution })
  );
  const tp = applied.filter((r) => answerOf(r) === mapping.applied).length;
  const tn = rejected.filter((r) => answerOf(r) === mapping.rejected).length;
  return { n: new Set(rows.map((r) => r.finding_id)).size, tpr: tp / applied.length, tnr: tn / rejected.length };
}

/** The live half: correlates a `zz.eval_finding` decision with the evaluator answers recorded
 *  for the SAME measure in the SAME evaluation run, through `zz.eval_assessment`, which
 *  `evaluation_assess` writes. A finding is a judgement of its own run's answers, so an answer from
 *  another run is never paired with it; `computeLabelStats` above answers `null` on an empty set.
 *
 *  The correlation is by measure: a qualification is about a measure and an assessment names the
 *  measure it was taken for, so `evaluator_version_id` is reached through it, and two measures
 *  deferring to one evaluator version is exactly the case this must not merge. */
export async function labelEvidence(
  pool: pg.Pool, measureId: string, mapping: LabelMapping | null,
): Promise<LadderLabels | null> {
  if (!mapping) return null;
  const { rows } = await pool.query<LabelRow>(`
    select f.id::text as finding_id, f.decision as decision, a.answer_kind as answer_kind, a.reading as reading,
           a.distribution as distribution
      from zz.eval_finding f
      join zz.eval_assessment ea on ea.measure_id = f.measure_id and ea.eval_run_id = f.eval_run_id
      join zz.assessment a on a.id = ea.assessment_id
     where f.measure_id = $1::uuid and f.decision in ('applied', 'rejected')`,
    [measureId]);
  return computeLabelStats(rows, mapping);
}
