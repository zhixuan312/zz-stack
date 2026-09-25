/**
 * Evidence gathering for `evaluator_qualify` (Task I-11): anchors, planted faults, controls,
 * stability and labels, each read from the same sources the contract names.
 *
 *   - Anchors are known answers derived from snapshot facts (FR-16): this platform's own
 *     `zz.eval_observation_snapshot` already carries `usable_run_count`/`total_run_count` and a
 *     `coverage.surface.{observed,total}` pair — real counted numbers, not recomputed here — so
 *     an anchor is a plain-English statement of one of those counts, with a YES/NO-shaped truth
 *     value ("more than zero") the evaluator is asked to read off it. Which two strings in the
 *     evaluator's OWN vocabulary count as "yes" and "no" is protocol content this task's own
 *     boundary leaves free ("final deliverable content is not in this plan"): the bound
 *     `zz.eval_measure.definition.qualification` object names them as `{ positive, zero }`. No
 *     measure bound to this evaluator in this protocol version, or no `qualification` object on
 *     it, means no anchor can be built — the contract's own `no_anchors` path.
 *   - Planted faults are mutations of an anchor built from the evaluator's own failure mode: the
 *     one fact this file can mutate cheaply and still know the true answer to is the count's own
 *     sign, so a fault flips "more than zero" to "zero" (or back) and asks again. Killed means
 *     the evaluator's answer flipped with it — proof it is reading the number, not repeating a
 *     memorised answer.
 *   - Controls are another plugin's own real evidence (never a mutation): the same fact,
 *     unmutated, read off the most recently observed OTHER plugin. A control passes (the
 *     response's `failed_as_expected`) when the evaluator answers what the FOREIGN number says —
 *     proof it reads the number in front of it rather than an answer it holds for this plugin.
 *   - Stability is the first anchor, asked three times; `agreeing` counts the modal answer.
 *   - Labels come only through the protocol's `qualification.labelMappings`, matched by this
 *     evaluator's own `stable_key` — see `parseLabelMappings`/`mappingFor`. The correlation this
 *     needs (a specific evaluator answer tied to a specific `zz.eval_finding` decision, through
 *     `zz.eval_assessment`) has no writer yet: EVALUATE, a later task, is what populates
 *     `zz.eval_assessment`. The query below is real and will be exercised the day that exists;
 *     until then it finds nothing, and `labels: null` is not a shortfall here — it is what
 *     "final deliverable content is not in this plan" means for the fourth rung.
 */
import type pg from "pg";

import { askEvaluatorQuestion, type AskedEvaluatorAnswer, type EvaluatorAssessmentResult } from "../semantic.js";
import type { LadderCounts, LadderLabels } from "./qualify-ladder.js";

/** The evaluator's own vocabulary for "this count is positive" / "this count is zero", named by
 *  the bound measure's `definition.qualification` — the one piece of protocol content an anchor
 *  needs and this task does not fix a platform-wide value for (a `choice` evaluator's criteria
 *  keys are its own protocol's business). Not exported: `qualify.ts` passes this shape into
 *  `gatherCountedEvidence` structurally, never by this type's name. */
interface AnchorVocabulary { readonly positive: string; readonly zero: string }

/** The two counted facts this file knows how to state in English, each a real column (or a
 *  column's own nested field) already stored on `zz.eval_observation_snapshot` — never
 *  recomputed, so gathering evidence costs no re-derivation of OBSERVE's own work. */
const FACT_STATEMENTS: Readonly<Record<string, (n: number, d: number) => string>> = Object.freeze({
  usable_run_coverage: (n, d) =>
    `Of ${d} run(s) recorded for this plugin in its most recently observed window, ${n} were usable.`,
  tool_coverage: (n, d) =>
    `Of ${d} tool(s) this plugin can reach, ${n} were actually called in its most recently observed window.`,
});

export interface SnapshotRow {
  readonly id: string;
  readonly usable_run_count: number;
  readonly total_run_count: number;
  readonly coverage: { surface?: { observed?: number; total?: number } } | null;
}

function factValue(key: string, snapshot: SnapshotRow): { n: number; d: number } | null {
  if (key === "usable_run_coverage") {
    const d = snapshot.total_run_count;
    return d > 0 ? { n: snapshot.usable_run_count, d } : null;
  }
  if (key === "tool_coverage") {
    const d = snapshot.coverage?.surface?.total ?? 0;
    const n = snapshot.coverage?.surface?.observed ?? 0;
    return d > 0 ? { n, d } : null;
  }
  return null;
}

/** One anchor as this file builds it: which fact it came from, the counted numbers behind it (so
 *  a fault or a control can recompute the statement against a different numerator), the subject
 *  text the evaluator is actually asked about, and the expected answer in the evaluator's own
 *  vocabulary. */
interface Anchor {
  readonly key: string;
  readonly n: number;
  readonly d: number;
  readonly subject: string;
  readonly expected: string;
}

/** Every anchor this snapshot and this vocabulary can support — at most one per entry in
 *  `FACT_STATEMENTS`, so at most two today. `vocabulary === null` (no bound measure, or a bound
 *  measure with no usable `qualification` object) yields no anchors at all: the contract's own
 *  `no_anchors` path, reached honestly rather than guessed at. */
function buildAnchors(snapshot: SnapshotRow | null, vocabulary: AnchorVocabulary | null): Anchor[] {
  if (!snapshot || !vocabulary) return [];
  const anchors: Anchor[] = [];
  for (const key of Object.keys(FACT_STATEMENTS)) {
    const fact = factValue(key, snapshot);
    if (!fact) continue;
    const expected = fact.n > 0 ? vocabulary.positive : vocabulary.zero;
    anchors.push({ key, n: fact.n, d: fact.d, subject: FACT_STATEMENTS[key](fact.n, fact.d), expected });
  }
  return anchors;
}

/** The same fact, its numerator's sign flipped ("more than zero" <-> "zero"), which flips the
 *  expected answer with it. This IS the mutation: the evaluator's failure mode this file can
 *  target without a model of its own is "answers from memory rather than from the number it was
 *  handed", and flipping the sign is the smallest change that tests exactly that. */
function faultOf(anchor: Anchor, vocabulary: AnchorVocabulary): Anchor {
  const n = anchor.n > 0 ? 0 : anchor.d;
  const expected = n > 0 ? vocabulary.positive : vocabulary.zero;
  return { key: anchor.key, n, d: anchor.d, subject: FACT_STATEMENTS[anchor.key](n, anchor.d), expected };
}

/** The same fact key, read off a DIFFERENT plugin's own real (unmutated) snapshot — the
 *  contract's "controls come from other plugins' artifacts" — with the answer ITS numbers call
 *  for. `null` when the foreign snapshot never recorded this fact (a zero denominator) — that
 *  fact key simply contributes no control. */
export function controlOf(anchor: Anchor, foreign: SnapshotRow, vocabulary: AnchorVocabulary): { subject: string; expected: string } | null {
  const fact = factValue(anchor.key, foreign);
  if (!fact) return null;
  return { subject: FACT_STATEMENTS[anchor.key](fact.n, fact.d), expected: fact.n > 0 ? vocabulary.positive : vocabulary.zero };
}

/** What one asked answer reduces to, in whatever vocabulary the evaluator's own kind speaks: a
 *  `noul`'s `yes`/`no` reading (never `unclear`/`unavailable` — those match no anchor's expected
 *  string by construction), or a `choice`/`score`'s highest-probability option. `null` means no
 *  comparable answer came back — a distribution-less choice/score, or an unavailable noul. */
function normalizeAnswer(r: Pick<EvaluatorAssessmentResult, "answer_kind" | "reading" | "distribution">): string | null {
  if (r.answer_kind === "noul") return r.reading === "yes" || r.reading === "no" ? r.reading : null;
  if (!r.distribution) return null;
  const top = Object.entries(r.distribution).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/** anchors + planted faults + controls + stability, all four counted-evidence categories the
 *  ladder reads, gathered against one evaluator version. Every ask goes through
 *  `askEvaluatorQuestion` directly (this file already holds the `evaluator_version_id` it
 *  needs — the same reason `discover.ts` bypasses `evaluators.ts`'s `askEvaluator` wrapper) and
 *  records NOTHING: each answer comes back in `asked`, in ask order, for the caller to write
 *  through its own transaction (`qualify.ts`'s `recordQualification`). Asking here and writing
 *  there keeps every model call (up to nine, each up to ~100s) outside any open transaction. */
export async function gatherCountedEvidence(opts: {
  evaluatorVersionId: string;
  principal: string;
  snapshot: SnapshotRow | null;
  foreignSnapshot: SnapshotRow | null;
  vocabulary: AnchorVocabulary | null;
}): Promise<{
  counts: { anchors: LadderCounts; planted_faults: LadderCounts; controls: LadderCounts; stability: LadderCounts };
  asked: AskedEvaluatorAnswer[];
}> {
  const asked: AskedEvaluatorAnswer[] = [];
  const ask = async (subject: string): Promise<string | null> => {
    const answer = await askEvaluatorQuestion({
      evaluator_version_id: opts.evaluatorVersionId, subject_text: subject, askedBy: opts.principal,
    });
    asked.push(answer);
    return normalizeAnswer(answer.result);
  };
  const anchors = buildAnchors(opts.snapshot, opts.vocabulary);
  if (!anchors.length) {
    return {
      counts: {
        anchors: { passed: 0, total: 0 }, planted_faults: { passed: 0, total: 0 },
        controls: { passed: 0, total: 0 }, stability: { passed: 0, total: 0 },
      },
      asked,
    };
  }

  let anchorsPassed = 0;
  for (const a of anchors) {
    const answer = await ask(a.subject);
    if (answer === a.expected) anchorsPassed += 1;
  }

  let faultsKilled = 0;
  let faultsTotal = 0;
  if (opts.vocabulary) {
    for (const a of anchors) {
      const fault = faultOf(a, opts.vocabulary);
      faultsTotal += 1;
      const answer = await ask(fault.subject);
      if (answer === fault.expected) faultsKilled += 1;
    }
  }

  let controlsFailedAsExpected = 0;
  let controlsTotal = 0;
  if (opts.foreignSnapshot && opts.vocabulary) {
    for (const a of anchors) {
      const control = controlOf(a, opts.foreignSnapshot, opts.vocabulary);
      if (!control) continue;
      controlsTotal += 1;
      const answer = await ask(control.subject);
      // Passed when the evaluator answers what the FOREIGN number says. Measuring it against this
      // plugin's own anchor instead failed every truthful evaluator whenever the other plugin's
      // count had the same sign as this one's — two plugins both in use, the ordinary case — and
      // capped every measure at mechanically_qualified for reading correctly.
      if (answer === control.expected) controlsFailedAsExpected += 1;
    }
  }

  const stabilityAnchor = anchors[0];
  const stabilityAnswers: (string | null)[] = [];
  for (let i = 0; i < 3; i += 1) {
    stabilityAnswers.push(await ask(stabilityAnchor.subject));
  }
  const modal = new Map<string | null, number>();
  for (const a of stabilityAnswers) modal.set(a, (modal.get(a) ?? 0) + 1);
  const agreeing = Math.max(...modal.values());

  return {
    counts: {
      anchors: { passed: anchorsPassed, total: anchors.length },
      planted_faults: { passed: faultsKilled, total: faultsTotal },
      controls: { passed: controlsFailedAsExpected, total: controlsTotal },
      stability: { passed: agreeing, total: 3 },
    },
    asked,
  };
}

/** A platform-owned evaluator's own known answers — for an evaluator no protocol measure defers
 *  to, and so no snapshot fact can anchor. `anchors` carry the answer each text truly has;
 *  `faults` are the same content re-attributed so the true answer flips with it; `controls` are
 *  material of another kind, whose answer must NOT be the anchor's. The texts live beside the
 *  evaluator's own question (`replay-derive.ts`), so a change to one is a change to both. */
export interface KnownAnswers {
  readonly anchors: readonly { readonly subject: string; readonly expected: string }[];
  readonly faults: readonly { readonly subject: string; readonly expected: string }[];
  readonly controls: readonly { readonly subject: string; readonly notExpected: string }[];
}

/** The same four counted categories `gatherCountedEvidence` returns, over known answers instead
 *  of snapshot facts: anchors must match, faults must match their flipped answer, controls must
 *  differ from the answer they are the opposite of, and the first anchor is asked three times. */
export async function gatherKnownAnswerEvidence(opts: {
  evaluatorVersionId: string; principal: string; known: KnownAnswers;
}): Promise<{
  counts: { anchors: LadderCounts; planted_faults: LadderCounts; controls: LadderCounts; stability: LadderCounts };
  asked: AskedEvaluatorAnswer[];
}> {
  const asked: AskedEvaluatorAnswer[] = [];
  const ask = async (subject: string): Promise<string | null> => {
    const answer = await askEvaluatorQuestion({
      evaluator_version_id: opts.evaluatorVersionId, subject_text: subject, askedBy: opts.principal,
    });
    asked.push(answer);
    return normalizeAnswer(answer.result);
  };
  const count = async (items: readonly { subject: string }[], passes: (i: number, a: string | null) => boolean): Promise<LadderCounts> => {
    let passed = 0;
    for (let i = 0; i < items.length; i += 1) if (passes(i, await ask(items[i].subject))) passed += 1;
    return { passed, total: items.length };
  };
  const { anchors, faults, controls } = opts.known;
  const anchorCounts = await count(anchors, (i, a) => a === anchors[i].expected);
  const faultCounts = await count(faults, (i, a) => a === faults[i].expected);
  const controlCounts = await count(controls, (i, a) => a !== null && a !== controls[i].notExpected);
  const stability: (string | null)[] = [];
  if (anchors.length) for (let i = 0; i < 3; i += 1) stability.push(await ask(anchors[0].subject));
  const modal = new Map<string | null, number>();
  for (const a of stability) modal.set(a, (modal.get(a) ?? 0) + 1);
  return {
    counts: {
      anchors: anchorCounts, planted_faults: faultCounts, controls: controlCounts,
      stability: { passed: stability.length ? Math.max(...modal.values()) : 0, total: stability.length },
    },
    asked,
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
