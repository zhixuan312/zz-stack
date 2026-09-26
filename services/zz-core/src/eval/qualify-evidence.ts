/**
 * Evidence gathering for `evaluator_qualify` (Task I-11): anchors, planted faults, controls,
 * stability and labels.
 *
 *   - Anchors, faults and controls are the measure's OWN known-answer texts, declared in the
 *     protocol as `definition.qualification.anchors: [{ id, role, text, expected }]`
 *     (`MeasureQualification` in `@zz/contracts`). Each is asked the measure's own question —
 *     the evaluator version is the measure's — and passes when the answer is `expected`. An
 *     earlier version built anchors from snapshot counts ("Of N runs … M were usable") and asked
 *     them against questions about documents and runs: a truthful evaluator answered no to every
 *     one, and no model-backed measure could ever qualify.
 *   - `role: "anchor"` feeds the anchor pass rate, `"fault"` (a good example with one planted
 *     defect) the fault kill rate, `"control"` (an artifact of another kind) the control catch rate.
 *   - Stability is the first `anchor` entry, asked three more times; `agreeing` counts the modal
 *     answer.
 *   - Labels come only through the protocol's `qualification.labelMappings`, matched by this
 *     evaluator's own `stable_key` — see `parseLabelMappings`/`mappingFor`. The correlation this
 *     needs (a specific evaluator answer tied to a specific `zz.eval_finding` decision, through
 *     `zz.eval_assessment`) has no writer yet: EVALUATE, a later task, is what populates
 *     `zz.eval_assessment`. The query below is real and will be exercised the day that exists;
 *     until then it finds nothing, and `labels: null` is not a shortfall here.
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
 *  `role: "stability"` rows are the repeated asks of the first anchor. */
export interface AnchorResult {
  readonly id: string;
  readonly role: MeasureAnchor["role"] | "stability";
  readonly expected: string;
  readonly got: string | null;
}

/** anchors + planted faults + controls + stability, the four counted-evidence categories the
 *  ladder reads, from the measure's declared texts. `ask` is the one model call — `qualify.ts`
 *  hands in one that asks the measure's evaluator version and keeps every answer for its own
 *  transaction to write; a check hands in a stub. Nothing here touches a database. */
export async function gatherCountedEvidence(opts: {
  anchors: readonly MeasureAnchor[];
  ask: (text: string) => Promise<Answer>;
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

  const tally = { anchor: { passed: 0, total: 0 }, fault: { passed: 0, total: 0 }, control: { passed: 0, total: 0 } };
  for (const a of opts.anchors) {
    const got = normalizeAnswer(await opts.ask(a.text));
    results.push({ id: a.id, role: a.role, expected: a.expected, got });
    tally[a.role].total += 1;
    if (got === a.expected) tally[a.role].passed += 1;
  }

  const firstAnswer = results.find((r) => r.id === first.id)?.got ?? null;
  const repeats: (string | null)[] = [firstAnswer];
  for (let i = 0; i < 2; i += 1) {
    const got = normalizeAnswer(await opts.ask(first.text));
    results.push({ id: first.id, role: "stability", expected: first.expected, got });
    repeats.push(got);
  }
  const modal = new Map<string | null, number>();
  for (const a of repeats) modal.set(a, (modal.get(a) ?? 0) + 1);

  return {
    counts: {
      anchors: tally.anchor, planted_faults: tally.fault, controls: tally.control,
      stability: { passed: Math.max(...modal.values()), total: repeats.length },
    },
    results,
  };
}

// ---------------------------------------------------------------------------------------------
// Labels — selection is pure (pinned alongside the ladder in this task's own check); the query
// that feeds it is real SQL that finds nothing until EVALUATE exists. See this file's header.

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
  readonly decision: "applied" | "rejected";
  readonly answer_kind: "noul" | "choice" | "score";
  readonly reading: "yes" | "no" | "unclear" | "unavailable" | null;
  readonly distribution: Readonly<Record<string, number>> | null;
}

/** Pure: a mapping and the correlated rows a live query found, reduced to `{n, tpr, tnr}`. `null`
 *  whenever either class (applied or rejected) is empty — a rate computed over zero examples of
 *  the other class is not a rate. */
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
  return { n: rows.length, tpr: tp / applied.length, tnr: tn / rejected.length };
}

/** The live half: correlates a `zz.eval_finding` decision with the evaluator answer recorded
 *  against the SAME measure, through `zz.eval_assessment` (which `evaluation_assess` — not this
 *  task — is what writes). Real SQL, exercised the day that writer exists; today it returns no
 *  rows on every deployment, and `computeLabelStats` above answers `null` on an empty set. */
export async function labelEvidence(
  pool: pg.Pool, measureId: string, evaluatorVersionId: string, mapping: LabelMapping | null,
): Promise<LadderLabels | null> {
  if (!mapping) return null;
  const { rows } = await pool.query<LabelRow>(`
    select f.decision as decision, a.answer_kind as answer_kind, a.reading as reading, a.distribution as distribution
      from zz.eval_finding f
      join zz.eval_assessment ea on ea.measure_id = f.measure_id
      join zz.assessment a on a.id = ea.assessment_id
     where f.measure_id = $1::uuid and ea.evaluator_version_id = $2::uuid
       and f.decision in ('applied', 'rejected')`,
    [measureId, evaluatorVersionId]);
  return computeLabelStats(rows, mapping);
}
